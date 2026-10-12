import { defaultConcurrency, mapWithConcurrency } from './async-utils.js';
import {
	ACCESS_TOKEN_REQUIREMENT,
	CloudflareAccessClient,
	planAccessApps,
	type ExistingAccessApp,
	type ExistingAccessPolicy,
} from './cloudflare-access.js';
import { loadTenantConfig, type ResolvedSite } from '../tenants/tenant-config.js';

export interface DeploymentAccessSite {
	id: string;
	title: string;
	hostname: string;
	authorizedEmails: readonly string[];
}

export interface DeploymentAccessIssue {
	siteId: string;
	hostname: string;
	kind: 'missing-app' | 'missing-policy';
	detail: string;
}

function deploymentSites(sites: readonly ResolvedSite[]): DeploymentAccessSite[] {
	return sites.map((site) => ({
		id: site.id,
		title: site.title,
		hostname: site.hostname,
		authorizedEmails: site.authorizedEmails,
	}));
}

/**
 * Turn the existing Access planner's actions into deployment-blocking issues.
 * A deployment is safe only when every target has an exact host-wide Access
 * application and every configured email is covered by an Allow policy.
 */
export function planDeploymentAccess(
	sites: readonly DeploymentAccessSite[],
	existingApps: readonly ExistingAccessApp[],
	policiesByAppId: ReadonlyMap<string, readonly ExistingAccessPolicy[]>,
): DeploymentAccessIssue[] {
	const actions = planAccessApps(sites, existingApps, policiesByAppId);
	const issues: DeploymentAccessIssue[] = [];

	for (const site of sites) {
		const siteActions = actions.filter((action) => action.siteId === site.id);
		const missingApp = siteActions.find((action) => action.kind === 'create-app');
		if (missingApp?.kind === 'create-app') {
			issues.push({
				siteId: site.id,
				hostname: site.hostname,
				kind: 'missing-app',
				detail: `no exact host-wide Access application protects ${site.hostname}`,
			});
			continue;
		}

		const policyDrift = siteActions.find(
			(action) =>
				action.kind === 'reconcile-policy' && action.missingEmails.length > 0,
		);
		if (policyDrift?.kind === 'reconcile-policy') {
			issues.push({
				siteId: site.id,
				hostname: site.hostname,
				kind: 'missing-policy',
				detail: `Access Allow policy is missing ${policyDrift.missingEmails.join(', ')}`,
			});
			continue;
		}

		if (!siteActions.some((action) => action.kind === 'adopt-app')) {
			issues.push({
				siteId: site.id,
				hostname: site.hostname,
				kind: 'missing-app',
				detail: `could not resolve an Access application for ${site.hostname}`,
			});
		}
	}

	return issues;
}

/**
 * Verify the Access perimeter before a real Worker deployment. This is
 * intentionally read-only: creation and policy reconciliation stay in the
 * explicit tenant provisioning phase used by release:all.
 */
export async function assertDeploymentAccess(
	options: {
		concurrency?: number;
		token?: string;
		accountId?: string | null;
	} = {},
): Promise<void> {
	const token = options.token?.trim() ?? process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
	if (!token) {
		throw new Error(
			`Refusing the deployment: Cloudflare Access protection ` +
				`cannot be verified because CLOUDFLARE_API_TOKEN is missing. ` +
				`The token needs the ${ACCESS_TOKEN_REQUIREMENT}.`,
		);
	}

	const { sites } = await loadTenantConfig();
	const targets = deploymentSites(sites);
	if (targets.length === 0) {
		throw new Error(`Refusing the deployment: no frontend sites are configured`);
	}

	const client = new CloudflareAccessClient(
		token,
		options.accountId === undefined
			? process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || null
			: options.accountId,
	);
	const existingApps = await client.listApps();
	const initialActions = planAccessApps(targets, existingApps, new Map());
	const matchedApps = initialActions
		.filter((action) => action.kind === 'adopt-app')
		.map((action) => action.appId);
	const policiesByAppId = new Map<string, ExistingAccessPolicy[]>();
	const policyResults = await mapWithConcurrency(
		[...new Set(matchedApps)],
		options.concurrency ?? defaultConcurrency(),
		async (appId) => [appId, await client.listPolicies(appId)] as const,
	);
	for (const [appId, policies] of policyResults) policiesByAppId.set(appId, policies);

	const issues = planDeploymentAccess(targets, existingApps, policiesByAppId);
	if (issues.length > 0) {
		throw new Error([
			`Refusing the deployment: Cloudflare Access is incomplete.`,
			...issues.map((issue) => `- ${issue.siteId} (${issue.hostname}): ${issue.detail}`),
			'Run `pnpm ensure:tenant -- --set-secret` to reconcile it before deploying.',
		].join('\n'));
	}
}
