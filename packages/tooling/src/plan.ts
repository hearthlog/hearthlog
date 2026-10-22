/**
 * `hearthlog plan`: what deploying one tenant would create, in what order, and
 * what stops it. Pure: the caller resolves names from `tenants.json`, the
 * tenant files, and the module manifests, so the planner can be tested and
 * run with no credentials and no network.
 */

export type StepId = 'resources' | 'ledger' | 'ledger-app' | 'frontend' | 'verify';

export interface PlanModule {
    id: string;
    version: string;
}

/** A name the tenant's Workers bind or create, with whether it holds data that must survive. */
export interface PlannedResource {
    kind: 'frontend-worker' | 'ledger-worker' | 'calendar-feed-worker' | 'public-worker' | 'r2-bucket' | 'ledger-app' | 'access-app';
    name: string;
    /** Never deleted by apply, whatever the plan says. */
    stateful: boolean;
    billable: 'workers' | 'durable-objects' | 'r2' | 'access';
}

export interface PlannedStep {
    id: StepId;
    summary: string;
    /** The step's work is the first mint of a credential: it must never run again once recorded. */
    mintsCredentials: boolean;
}

export interface TenantResources {
    ledgerWorker: string;
    /** R2 bindings the tenant's gateway gets, by Worker binding name. */
    buckets: Array<{ binding: string; bucket: string }>;
    calendarFeedsBucket: string;
    calendarPublicWorker: string;
    /** Anonymous Workers a module deploys beside the gateway (Gallery's public pages). */
    publicWorkers: string[];
}

export interface PlanInput {
    site: {
        id: string;
        origin: string;
        features: string[];
        authorizedEmails: string[];
        ledgerAppName: string;
        /** Null: the site is served by the shared Ledger and buckets. */
        deployment: { resourcePrefix: string; accountId?: string } | null;
    };
    modules: PlanModule[];
    resources: TenantResources;
    accessTeamDomain: string;
    /** Every other site's resources, and the shared stack's, for the isolation check. */
    others: Array<{ id: string; resources: TenantResources }>;
    /** Absent in a repository with no shared stack (a site that owns its stack and is the only one in it). */
    shared?: TenantResources;
}

export interface DeploymentPlan {
    siteId: string;
    origin: string;
    topology: 'dedicated' | 'shared';
    accountId: string | null;
    modules: PlanModule[];
    resources: PlannedResource[];
    steps: PlannedStep[];
    /** Anything here stops `hearthlog apply`. */
    problems: string[];
    /** Worth reading, not blocking. */
    warnings: string[];
}

function owned(resources: TenantResources): Map<string, string> {
    const names = new Map<string, string>();
    names.set(resources.ledgerWorker, 'ledger Worker');
    names.set(`${resources.ledgerWorker}-archive`, 'bucket');
    for (const { bucket } of resources.buckets) names.set(bucket, 'bucket');
    names.set(resources.calendarFeedsBucket, 'bucket');
    names.set(resources.calendarPublicWorker, 'Worker');
    for (const worker of resources.publicWorkers) names.set(worker, 'Worker');
    return names;
}

/** The tenant's own names that another tenant (or the shared stack) also holds. */
export function isolationProblems(input: Pick<PlanInput, 'site' | 'resources' | 'others' | 'shared'>): string[] {
    const mine = owned(input.resources);
    const problems: string[] = [];
    const against = [...input.others.map((other) => ({ label: `site "${other.id}"`, resources: other.resources })), ...(input.shared ? [{ label: 'the shared stack', resources: input.shared }] : [])];
    for (const other of against) {
        // A tenant on the shared stack is declared to share it; only a dedicated one must not.
        if (!input.site.deployment) continue;
        const theirs = owned(other.resources);
        for (const [name, kind] of mine) {
            if (theirs.has(name)) problems.push(`${kind} "${name}" is also used by ${other.label}: this tenant's gateway would reach its data`);
        }
    }
    if (input.site.deployment) {
        const prefix = `${input.site.deployment.resourcePrefix}-`;
        for (const [name, kind] of mine) {
            if (!name.startsWith(prefix)) problems.push(`${kind} "${name}" does not start with the resource prefix "${prefix}"`);
        }
    }
    return problems;
}

export function planDeployment(input: PlanInput): DeploymentPlan {
    const { site, resources } = input;
    const dedicated = site.deployment !== null;
    const problems = isolationProblems(input);
    const warnings: string[] = [];
    if (!input.accessTeamDomain) problems.push('No Cloudflare Access team is configured: the site would be deployed unprotected');
    if (site.authorizedEmails.length === 0) problems.push('No user is allowed in: the Access policy would be empty');
    if (dedicated && !site.deployment!.accountId) warnings.push('deployment.json names no accountId, so the CLI login cannot be checked against the intended account');

    const planned: PlannedResource[] = [
        { kind: 'frontend-worker', name: site.id, stateful: false, billable: 'workers' },
        { kind: 'access-app', name: site.origin, stateful: false, billable: 'access' },
        { kind: 'ledger-app', name: site.ledgerAppName, stateful: true, billable: 'durable-objects' },
        { kind: 'calendar-feed-worker', name: resources.calendarPublicWorker, stateful: false, billable: 'workers' },
        { kind: 'r2-bucket', name: resources.calendarFeedsBucket, stateful: true, billable: 'r2' },
        { kind: 'r2-bucket', name: `${resources.ledgerWorker}-archive`, stateful: true, billable: 'r2' },
        ...resources.buckets.map(({ bucket }): PlannedResource => ({ kind: 'r2-bucket', name: bucket, stateful: true, billable: 'r2' })),
        ...resources.publicWorkers.map((name): PlannedResource => ({ kind: 'public-worker', name, stateful: false, billable: 'workers' })),
    ];
    if (dedicated) planned.unshift({ kind: 'ledger-worker', name: resources.ledgerWorker, stateful: true, billable: 'durable-objects' });

    const steps: PlannedStep[] = [
        { id: 'resources', summary: 'Create the buckets and the Access application (existing ones are kept)', mintsCredentials: false },
        ...(dedicated ? [{ id: 'ledger' as const, summary: `Deploy ${resources.ledgerWorker} and generate its administrator token and signing key once`, mintsCredentials: true }] : []),
        { id: 'ledger-app', summary: `Register the Ledger application "${site.ledgerAppName}" with the site's event policy and give the gateway its token (an existing application keeps its token and policy)`, mintsCredentials: true },
        { id: 'frontend', summary: 'Build and deploy the gateway and the public Workers', mintsCredentials: false },
        { id: 'verify', summary: 'Check that the origin is not served without signing in', mintsCredentials: false },
    ];
    return {
        siteId: site.id,
        origin: site.origin,
        topology: dedicated ? 'dedicated' : 'shared',
        accountId: site.deployment?.accountId ?? null,
        modules: input.modules,
        resources: planned,
        steps,
        problems,
        warnings,
    };
}

export function renderPlan(plan: DeploymentPlan): string {
    const lines = [
        `Tenant ${plan.siteId} (${plan.topology}) at ${plan.origin}`,
        `Modules: ${plan.modules.map((module) => `${module.id}@${module.version}`).join(', ') || 'none'}`,
        '',
        'Resources:',
        ...plan.resources.map((resource) => `  ${resource.kind.padEnd(20)} ${resource.name}${resource.stateful ? '  (kept; never deleted)' : ''}  [${resource.billable}]`),
        '',
        'Steps:',
        ...plan.steps.map((step, index) => `  ${index + 1}. ${step.id}: ${step.summary}`),
    ];
    if (plan.warnings.length) lines.push('', 'Warnings:', ...plan.warnings.map((warning) => `  - ${warning}`));
    if (plan.problems.length) lines.push('', 'Problems (apply refuses until fixed):', ...plan.problems.map((problem) => `  - ${problem}`));
    return `${lines.join('\n')}\n`;
}
