/**
 * Cloudflare Zero Trust Access planning and API access for tenant
 * provisioning.
 *
 * `planAccessApps` is a pure function (unit-tested) that decides, for every
 * tenant hostname, whether an Access application can be adopted or must be
 * created, and whether the owner Allow policy is already present.
 * `CloudflareAccessClient` is the thin REST runner for the decisions the
 * planner makes (account-scoped `/access/apps` endpoints).
 *
 * API token requirements (Account scoped):
 *   - Access: Apps and Policies -> Edit
 *   - Access: Service Tokens -> Edit (only for sites with integrations)
 *   - Account Settings -> Read (only for automatic account-id discovery)
 */

export interface AccessSiteInput {
    id: string;
    title: string;
    hostname: string;
    /** Every email that must be allowed through the Access application. */
    authorizedEmails: readonly string[];
    /** Ids of the site's service integrations; any makes it need the integrations application. */
    integrations?: readonly string[];
}

export interface ExistingAccessApp {
    id: string;
    name: string;
    domain: string;
    aud: string;
}

export interface ExistingAccessPolicy {
    id: string;
    name: string;
    decision: string;
    include: unknown[];
    /**
     * Account-level (reusable) policy. The app-scoped endpoints refuse to
     * update or delete it (error 12130); those operations go through
     * `/accounts/{account_id}/access/policies/{policy_id}`. Resolved from the
     * app-scoped response when it carries the flag and otherwise from the
     * account-level registry of reusable policies.
     */
    reusable?: boolean;
}

export type AccessAction =
    | {
          kind: "adopt-app";
          siteId: string;
          appId: string;
          aud: string;
          name: string;
      }
    | { kind: "create-app"; siteId: string; hostname: string; name: string }
    | {
          kind: "reconcile-policy";
          siteId: string;
          appId: string;
          /**
           * Existing pure-email Allow policies to fold into `emails`. The
           * first is updated in place; any others are deleted. Empty means a
           * new policy must be created.
           */
          replacePolicyIds: string[];
          /** The complete authorized email list, lower-cased and deduped. */
          emails: string[];
          /** Authorized emails not granted by any current Allow policy. */
          missingEmails: string[];
      };

export const ALLOW_POLICY_NAME = "Site access (allow)";

/**
 * Calendar feeds used to be served from the site itself, behind a path-scoped
 * Bypass application. They now live on their own Worker, so this application
 * is retired.
 */
export const FEED_PATH_SUFFIX = "/api/calendar-feed/*";

/** What the CLOUDFLARE_API_TOKEN must allow for the Access phase to run. */
export const ACCESS_TOKEN_REQUIREMENT =
    '"Access: Apps and Policies -> Edit" permission, plus "Access: Service Tokens -> Edit" for integrations' +
    ' (plus "Account Settings -> Read" unless CLOUDFLARE_ACCOUNT_ID is set)';

/**
 * Applications protect `host` or `host/path`; only an application whose
 * domain is exactly the bare hostname protects the whole site.
 */
function bareHost(domain: string): string {
    return domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .split("/")[0] ?? "";
}

/** Union of the emails granted by the application's Allow policies. */
function grantedEmails(policies: readonly ExistingAccessPolicy[]): Set<string> {
    const granted = new Set<string>();
    for (const policy of policies) {
        if (policy.decision.toLowerCase() !== "allow") continue;
        for (const email of extractPolicyEmails(policy.include)) granted.add(email);
    }
    return granted;
}

export function extractPolicyEmails(include: unknown[]): string[] {
    const emails: string[] = [];
    for (const entry of include) {
        const record = entry as { email?: { email?: unknown } };
        const email = record?.email?.email;
        if (typeof email === "string") emails.push(email.toLowerCase());
    }
    return emails;
}

function isEmailEntry(entry: unknown): boolean {
    const record = entry as { email?: { email?: unknown } };
    return typeof record?.email?.email === "string";
}

/**
 * An Allow policy we manage: every `include` entry is an email rule. Policies
 * that mix email rules with other selectors (IP, group, everyone, …) are left
 * untouched so manual access rules survive reconciliation.
 */
function isPureEmailAllowPolicy(policy: ExistingAccessPolicy): boolean {
    return (
        policy.decision.toLowerCase() === "allow" &&
        Array.isArray(policy.include) &&
        policy.include.length > 0 &&
        policy.include.every(isEmailEntry)
    );
}

/** Trim, lower-case, drop blanks, and dedupe while preserving declaration order. */
function normalizeEmailList(emails: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const email of emails) {
        const normalized = email.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

/**
 * Decide the access actions for every site. Applications are matched by
 * exact bare hostname (path-scoped applications such as an admin-path app on
 * the same hostname are ignored); when several applications share a hostname
 * the one whose name equals the site title is preferred. A matched
 * application is always reported as `adopt-app` (its aud is required for the
 * worker secret). The app's pure-email Allow policies are reconciled to
 * exactly `authorizedEmails`: a removed email drops out (the policy is
 * rewritten and redundant policies deleted), an added email appears, and a
 * satisfied set produces no policy action at all.
 */
export function planAccessApps(
    sites: readonly AccessSiteInput[],
    existingApps: readonly ExistingAccessApp[],
    policiesByAppId: ReadonlyMap<string, readonly ExistingAccessPolicy[]>,
): AccessAction[] {
    const actions: AccessAction[] = [];

    for (const site of sites) {
        const hostname = bareHost(site.hostname);
        const candidates = existingApps.filter(
            (app) => app.domain.trim().toLowerCase() === hostname,
        );
        const app =
            candidates.find((candidate) => candidate.name === site.title) ??
            candidates[0];

        if (!app) {
            actions.push({
                kind: "create-app",
                siteId: site.id,
                hostname,
                name: site.title,
            });
            continue;
        }

        const policies = policiesByAppId.get(app.id) ?? [];
        const managed = policies.filter(isPureEmailAllowPolicy);
        const managedEmails = new Set<string>();
        for (const policy of managed) {
            for (const email of extractPolicyEmails(policy.include)) {
                managedEmails.add(email);
            }
        }
        const desired = normalizeEmailList(site.authorizedEmails);
        const granted = grantedEmails(policies);
        const missingEmails = desired.filter((email) => !granted.has(email));
        const emailsDiffer =
            desired.length !== managedEmails.size ||
            desired.some((email) => !managedEmails.has(email));
        if (managed.length === 0 || emailsDiffer) {
            actions.push({
                kind: "reconcile-policy",
                siteId: site.id,
                appId: app.id,
                replacePolicyIds: managed.map((policy) => policy.id),
                emails: desired,
                missingEmails,
            });
        }
        actions.push({
            kind: "adopt-app",
            siteId: site.id,
            appId: app.id,
            aud: app.aud,
            name: app.name,
        });
    }

    return actions;
}

/** Exact path-scoped domain of the retired calendar-feed Bypass application. */
export function feedAppDomain(hostname: string): string {
    return `${bareHost(hostname)}${FEED_PATH_SUFFIX}`;
}

/**
 * The retired Bypass applications of a site, which `ensure:tenant` deletes. Only
 * applications on the exact feed domain are returned; the site's own and its
 * integrations application are never touched.
 */
export function planFeedBypassRemoval(
    site: Pick<AccessSiteInput, "hostname">,
    existingApps: readonly ExistingAccessApp[],
): ExistingAccessApp[] {
    const domain = feedAppDomain(site.hostname);
    return existingApps.filter((candidate) => candidate.domain.trim().toLowerCase() === domain);
}

/** The service-ingest path: callers present an Access service token, never a login. */
export const INTEGRATIONS_PATH_SUFFIX = "/api/integrations/*";
export const INTEGRATIONS_POLICY_NAME = "Service integrations (service auth)";

/** Exact path-scoped domain of a site's integrations Access application. */
export function integrationsAppDomain(hostname: string): string {
    return `${bareHost(hostname)}${INTEGRATIONS_PATH_SUFFIX}`;
}

export type IntegrationsAccessAction =
    | { kind: "create-integrations-app"; siteId: string; hostname: string; domain: string; name: string }
    | { kind: "adopt-integrations-app"; siteId: string; appId: string; aud: string };

/**
 * Plan the path-scoped application for service ingest. It is separate from the
 * site application on purpose: its audience differs, so a service-token JWT is
 * useless on every other route, and Access itself refuses the token elsewhere.
 * Null when the site has no integrations.
 */
export function planIntegrationsApp(
    site: AccessSiteInput,
    existingApps: readonly ExistingAccessApp[],
): IntegrationsAccessAction | null {
    if (!site.integrations || site.integrations.length === 0) return null;
    const domain = integrationsAppDomain(site.hostname);
    const app = existingApps.find((candidate) => candidate.domain.trim().toLowerCase() === domain);
    if (app) return { kind: "adopt-integrations-app", siteId: site.id, appId: app.id, aud: app.aud };
    return {
        kind: "create-integrations-app",
        siteId: site.id,
        hostname: bareHost(site.hostname),
        domain,
        name: `${site.title} integrations`,
    };
}

export interface ServiceToken {
    /** The token's own id, which policies reference. */
    id: string;
    name: string;
    /** What callers send as CF-Access-Client-Id and what the JWT carries as common_name. */
    clientId: string;
    expiresAt: string | null;
}

export type ServicePolicyAction =
    | { kind: "none" }
    | { kind: "create"; tokenIds: string[] }
    | { kind: "update"; policyId: string; tokenIds: string[]; dropPolicyIds: string[] };

/** A policy this tool manages: Service Auth whose every rule names a service token. */
export function isServiceAuthPolicy(policy: ExistingAccessPolicy): boolean {
    return (
        policy.decision.toLowerCase() === "non_identity" &&
        policy.include.length > 0 &&
        policy.include.every((entry) => {
            const record = entry as { service_token?: unknown };
            return record !== null && typeof record === "object" && "service_token" in record;
        })
    );
}

export function serviceAuthTokenIds(policy: ExistingAccessPolicy): string[] {
    return policy.include.flatMap((entry) => {
        const token = (entry as { service_token?: { token_id?: unknown } }).service_token;
        return typeof token?.token_id === "string" ? [token.token_id] : [];
    });
}

/**
 * Reconcile the Service Auth policy to exactly the wanted tokens: a removed
 * integration loses access on the next run. With no tokens there is no policy,
 * and an application without one admits nobody.
 */
export function planServiceAuthPolicy(
    wantedTokenIds: readonly string[],
    policies: readonly ExistingAccessPolicy[],
): ServicePolicyAction {
    const wanted = [...new Set(wantedTokenIds)].sort();
    const managed = policies.filter(isServiceAuthPolicy);
    if (wanted.length === 0) {
        return managed.length === 0
            ? { kind: "none" }
            : { kind: "update", policyId: managed[0]!.id, tokenIds: [], dropPolicyIds: managed.slice(1).map((policy) => policy.id) };
    }
    const [keep, ...drop] = managed;
    if (!keep) return { kind: "create", tokenIds: wanted };
    const current = [...new Set(serviceAuthTokenIds(keep))].sort();
    if (drop.length === 0 && current.join() === wanted.join()) return { kind: "none" };
    return { kind: "update", policyId: keep.id, tokenIds: wanted, dropPolicyIds: drop.map((policy) => policy.id) };
}

export class CloudflareAccessClient {
    private readonly base = "https://api.cloudflare.com/client/v4";
    private accountIdPromise: Promise<string> | undefined;

    constructor(
        private readonly token: string,
        private readonly accountId: string | null,
        private readonly fetchRequest: typeof fetch = globalThis.fetch,
    ) {}

    /**
     * Read before updating: preserve unrelated settings and never recreate identities.
     * `resource` is `organizations`, `apps/{id}`, or a policy resource: a
     * reusable policy is addressed as `policies/{id}` (account scope) and an
     * app-scoped one as `apps/{id}/policies/{id}`.
     */
    async reconcileSessionDuration(
        resource: string,
        duration: string,
        dryRun: boolean,
        expectedAuthDomain?: string,
    ): Promise<boolean> {
        const accountId = await this.resolveAccountId();
        const path = `/accounts/${accountId}/access/${resource}`;
        const current = await this.request<Record<string, unknown>>('GET', path);
        if (expectedAuthDomain) {
            let authHostname: string;
            try {
                authHostname = new URL(expectedAuthDomain).hostname;
            } catch {
                throw new Error('infrastructure.accessTeamDomain is not a valid URL');
            }
            if (current.auth_domain !== authHostname) {
                throw new Error('The Access organization does not match infrastructure.accessTeamDomain');
            }
        }
        if (current.session_duration === duration) return false;
        if (dryRun) {
            console.log(`[dry-run] Would set Access ${resource} session duration to ${duration}`);
            return true;
        }
        // The organization PUT requires its existing auth domain in practice,
        // despite the schema marking it optional. Keep its name too, but do
        // not replay null/default authentication settings from the GET response.
        const body: Record<string, unknown> = resource === 'organizations'
            ? {
                auth_domain: current.auth_domain,
                name: current.name,
                session_duration: duration,
            }
            : { ...current, session_duration: duration };
        // Response-only fields are not part of the update contract. Account
        // policies carry a few more, and precedence is app-scoped only.
        const responseOnly = ['id', 'aud', 'created_at', 'updated_at', 'reusable'];
        if (resource.startsWith('policies/')) {
            responseOnly.push('account_id', 'app_count', 'precedence');
        }
        for (const key of responseOnly) {
            delete body[key];
        }
        // Reference existing policies instead of submitting inline policy definitions.
        if (Array.isArray(body.policies)) {
            body.policies = body.policies.map((policy: string | { id: string; precedence?: number }) =>
                typeof policy === 'string' ? policy : {
                    id: policy.id,
                    ...(policy.precedence === undefined ? {} : { precedence: policy.precedence }),
                });
        }
        await this.request('PUT', path, body);
        console.log(`Set Access ${resource} session duration to ${duration}`);
        return true;
    }

    /** Resolve the account id from env or (as fallback) the API itself. */
    async resolveAccountId(): Promise<string> {
        if (this.accountId) return this.accountId;
        this.accountIdPromise ??= this.discoverAccountId();
        return await this.accountIdPromise;
    }

    private async discoverAccountId(): Promise<string> {
        const accounts = await this.request<
            Array<{ id: string; name: string }>
        >("GET", "/accounts?per_page=5");
        if (!Array.isArray(accounts) || accounts.length === 0) {
            throw new Error(
                "The API token grants no account access; set CLOUDFLARE_ACCOUNT_ID. " +
                    `Response: ${JSON.stringify(accounts).slice(0, 300)}`,
            );
        }
        if (accounts.length > 1) {
            console.warn(
                `Multiple accounts are visible; using "${accounts[0].name}". ` +
                    "Set CLOUDFLARE_ACCOUNT_ID to override.",
            );
        }
        return accounts[0].id;
    }

    async listApps(): Promise<ExistingAccessApp[]> {
        const accountId = await this.resolveAccountId();
        const apps: ExistingAccessApp[] = [];
        for (let page = 1; ; page += 1) {
            const pageApps = await this.request<
                Array<{
                    id: string;
                    name: string;
                    domain: string;
                    aud: string;
                }>
            >(
                "GET",
                `/accounts/${accountId}/access/apps?per_page=100&page=${page}`,
            );
            if (!Array.isArray(pageApps)) {
                throw new Error(
                    `Unexpected Access applications response shape: ` +
                        `${JSON.stringify(pageApps).slice(0, 500)}`,
                );
            }
            for (const app of pageApps) {
                if (app.aud) {
                    apps.push({
                        id: app.id,
                        name: app.name,
                        domain: app.domain,
                        aud: app.aud,
                    });
                }
            }
            // Full page heuristic: fewer results than the page size means the
            // last page (the endpoint may not report pagination info).
            if (pageApps.length < 100) break;
        }
        return apps;
    }

    async listPolicies(appId: string): Promise<ExistingAccessPolicy[]> {
        const accountId = await this.resolveAccountId();
        const policies = await this.request<
            Array<{
                id: string;
                name: string;
                decision: string;
                include: unknown[];
                reusable?: boolean;
            }>
        >("GET", `/accounts/${accountId}/access/apps/${appId}/policies`);
        // The app-scoped response may not mark a reusable policy, so fall back
        // to the account-level registry before deciding how to mutate it.
        const reusableIds = await this.reusablePolicyIds();
        return policies.map((policy) => ({
            id: policy.id,
            name: policy.name,
            decision: policy.decision,
            include: policy.include,
            reusable: policy.reusable === true || reusableIds.has(policy.id),
        }));
    }

    private reusablePolicyIdsPromise: Promise<Set<string>> | undefined;

    /** Ids of the account-level (reusable) policies, fetched once per client. */
    private reusablePolicyIds(): Promise<Set<string>> {
        this.reusablePolicyIdsPromise ??= this.loadReusablePolicyIds();
        return this.reusablePolicyIdsPromise;
    }

    private async loadReusablePolicyIds(): Promise<Set<string>> {
        const accountId = await this.resolveAccountId();
        const ids = new Set<string>();
        for (let page = 1; ; page += 1) {
            const policies = await this.request<Array<{ id: string }>>(
                "GET",
                `/accounts/${accountId}/access/policies?per_page=100&page=${page}`,
            );
            if (!Array.isArray(policies)) {
                throw new Error(
                    `Unexpected Access reusable policies response shape: ` +
                        `${JSON.stringify(policies).slice(0, 500)}`,
                );
            }
            for (const policy of policies) ids.add(policy.id);
            if (policies.length < 100) break;
        }
        return ids;
    }

    async listServiceTokens(): Promise<ServiceToken[]> {
        const accountId = await this.resolveAccountId();
        const tokens = await this.request<
            Array<{ id: string; name: string; client_id: string; expires_at?: string | null }>
        >("GET", `/accounts/${accountId}/access/service_tokens?per_page=100`);
        if (!Array.isArray(tokens)) {
            throw new Error(`Unexpected Access service tokens response shape: ${JSON.stringify(tokens).slice(0, 500)}`);
        }
        return tokens.map((token) => ({
            id: token.id,
            name: token.name,
            clientId: token.client_id,
            expiresAt: token.expires_at ?? null,
        }));
    }

    /** The secret is returned once, here, and never again. */
    async createServiceToken(name: string): Promise<ServiceToken & { clientSecret: string }> {
        const accountId = await this.resolveAccountId();
        const created = await this.request<{
            id: string;
            name: string;
            client_id: string;
            client_secret: string;
            expires_at?: string | null;
        }>("POST", `/accounts/${accountId}/access/service_tokens`, { name });
        return {
            id: created.id,
            name: created.name,
            clientId: created.client_id,
            clientSecret: created.client_secret,
            expiresAt: created.expires_at ?? null,
        };
    }

    async createServiceAuthPolicy(appId: string, tokenIds: readonly string[]): Promise<void> {
        const accountId = await this.resolveAccountId();
        await this.request("POST", `/accounts/${accountId}/access/apps/${appId}/policies`, this.serviceAuthPolicy(tokenIds));
    }

    async updateServiceAuthPolicy(
        appId: string,
        policyId: string,
        tokenIds: readonly string[],
        reusable = false,
    ): Promise<void> {
        const accountId = await this.resolveAccountId();
        await this.request(
            "PUT",
            this.policyPath(accountId, appId, policyId, reusable),
            this.serviceAuthPolicy(tokenIds),
        );
    }

    /**
     * Reusable policies live at the account scope: the app-scoped endpoints
     * reject updates and deletes of them (error 12130).
     */
    private policyPath(
        accountId: string,
        appId: string,
        policyId: string,
        reusable: boolean,
    ): string {
        return reusable
            ? `/accounts/${accountId}/access/policies/${policyId}`
            : `/accounts/${accountId}/access/apps/${appId}/policies/${policyId}`;
    }

    private serviceAuthPolicy(tokenIds: readonly string[]) {
        return {
            name: INTEGRATIONS_POLICY_NAME,
            decision: "non_identity",
            include: tokenIds.map((tokenId) => ({ service_token: { token_id: tokenId } })),
        };
    }

    async createApp(
        name: string,
        domain: string,
        sessionDuration?: string,
        extra: Record<string, unknown> = {},
    ): Promise<ExistingAccessApp> {
        const accountId = await this.resolveAccountId();
        const created = await this.request<{
            id: string;
            name: string;
            domain: string;
            aud: string;
        }>("POST", `/accounts/${accountId}/access/apps`, {
            name,
            domain,
            type: "self_hosted",
            ...(sessionDuration ? { session_duration: sessionDuration } : {}),
            ...extra,
        });
        return {
            id: created.id,
            name: created.name,
            domain: created.domain,
            aud: created.aud,
        };
    }

    async createAllowPolicy(
        appId: string,
        emails: readonly string[],
    ): Promise<void> {
        const accountId = await this.resolveAccountId();
        await this.request(
            "POST",
            `/accounts/${accountId}/access/apps/${appId}/policies`,
            {
                name: ALLOW_POLICY_NAME,
                decision: "allow",
                include: emails.map((email) => ({ email: { email } })),
            },
        );
    }

    /** Delete an application and the policies attached to it. */
    async deleteApp(appId: string): Promise<void> {
        const accountId = await this.resolveAccountId();
        await this.request("DELETE", `/accounts/${accountId}/access/apps/${appId}`);
    }

    /** Rewrite one policy's email list in place, dropping removed emails. */
    async updateAllowPolicy(
        appId: string,
        policyId: string,
        name: string,
        emails: readonly string[],
        reusable = false,
    ): Promise<void> {
        const accountId = await this.resolveAccountId();
        await this.request(
            "PUT",
            this.policyPath(accountId, appId, policyId, reusable),
            {
                name,
                decision: "allow",
                include: emails.map((email) => ({ email: { email } })),
            },
        );
    }

    /** Remove a redundant Allow policy left over from earlier provisioning. */
    async deletePolicy(
        appId: string,
        policyId: string,
        reusable = false,
    ): Promise<void> {
        const accountId = await this.resolveAccountId();
        await this.request(
            "DELETE",
            this.policyPath(accountId, appId, policyId, reusable),
        );
    }

    /**
     * Performs one API call and normalizes the two known Cloudflare response
     * shapes: the legacy envelope ({ success, result, errors }) and bare
     * payloads (arrays for list endpoints, objects for single resources).
     */
    private async request<T>(
        method: "GET" | "POST" | "PUT" | "DELETE",
        path: string,
        body?: unknown,
    ): Promise<T> {
        let response: Response;
        for (let attempt = 0; ; attempt += 1) {
            response = await this.fetchRequest(`${this.base}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    "Content-Type": "application/json",
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            if (response.status !== 429 && response.status < 500) break;
            if (attempt >= 2) break;
            const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
            console.warn(
                `Cloudflare API ${method} ${path} returned ${response.status}; ` +
                    `retrying in ${retryAfter}ms`,
            );
            await new Promise((resolve) => setTimeout(resolve, retryAfter));
        }
        const payload = (await response.json().catch(() => null)) as unknown;
        if (!response.ok) {
            throw this.apiError(method, path, response.status, payload);
        }
        if (
            payload &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            "success" in payload &&
            "result" in payload
        ) {
            const envelope = payload as {
                success: boolean;
                result: T;
                errors?: Array<{ code: number; message: string }>;
            };
            if (!envelope.success) {
                throw this.apiError(method, path, response.status, payload);
            }
            return envelope.result;
        }
        return payload as T;
    }

    private apiError(
        method: string,
        path: string,
        status: number,
        payload: unknown,
    ): Error {
        let detail = "unknown error";
        const errorCodes: number[] = [];
        if (payload && typeof payload === "object") {
            const record = payload as Record<string, unknown>;
            if (Array.isArray(record.errors)) {
                const errors = record.errors as Array<{
                    code: number;
                    message: string;
                }>;
                detail = errors
                    .map((error) => `${error.code}: ${error.message}`)
                    .join("; ");
                errorCodes.push(...errors.map((error) => error.code));
            } else if (record.error) {
                detail = String(record.error);
            } else {
                detail = JSON.stringify(payload).slice(0, 500);
            }
        }
        // Token problems arrive as 401/403 or, in practice, as 400 carrying
        // Cloudflare auth error codes (9106 "Authentication failed", 9109
        // "Unauthorized to access requested resource", 10000 "Authentication
        // error"). Say what the token must allow so the fix is obvious.
        const authFailure =
            status === 401 ||
            status === 403 ||
            errorCodes.some((code) =>
                code === 9106 || code === 9109 || code === 10000
            );
        const tokenHint = authFailure
            ? `\nThe CLOUDFLARE_API_TOKEN needs the ${path.endsWith("/access/organizations")
                ? '"Access: Organizations, Identity Providers, and Groups -> Edit" permission'
                : ACCESS_TOKEN_REQUIREMENT}.`
            : "";
        return new Error(
            `Cloudflare API ${method} ${path} failed (${status}): ${detail}${tokenHint}`,
        );
    }

}

function parseRetryAfter(value: string | null): number {
    if (!value) return 500;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(100, seconds * 1000));
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return 500;
    return Math.min(30_000, Math.max(100, timestamp - Date.now()));
}
