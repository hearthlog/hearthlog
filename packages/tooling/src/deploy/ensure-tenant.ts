#!/usr/bin/env npx tsx
/**
 * Ensure one tenant (or every tenant) is registered and protected, without
 * touching `.wrangler/tenants` as a required input.
 *
 * Phases, all idempotent:
 *   1. R2        — ensure the selected environment's shared buckets exist.
 *   2. Access    — ensure a Zero Trust Access application for the site's
 *                  workers.dev hostname, adopting an existing application,
 *                  and reconcile its Allow policy to exactly the authorized
 *                  emails (adding and removing as tenants.json changes). The
 *                  retired calendar-feed Bypass application, if present, is
 *                  deleted: feeds are served by their own Worker.
 *                  A site with service integrations also gets a path-scoped
 *                  application for /api/integrations/* with a Service Auth
 *                  policy that admits exactly its integrations' service tokens.
 *                  `--create-integration-token <id>` creates one token and
 *                  prints its client id and secret once.
 *   3. Ledger    — ensure the site's Ledger application. A token is minted
 *                  only when the application is first created, or when
 *                  `--rotate-token` is explicitly requested. An existing
 *                  application is left alone: its token already lives in the
 *                  Worker (Worker secrets survive code deploys) and rotating
 *                  would revoke the only principal and drop live WebSockets.
 *   4. Secrets   — push the tokens/secrets the Worker needs. Automatic on a
 *                  bootstrap or rotation; `--set-secret` forces a refresh.
 *
 * A site on its own stack (tenants/<id>/deployment.json) is ensured only with
 * `--site <id>`: its own buckets, and its Ledger application in its own Ledger,
 * whose administrator token comes from LEDGER_ADMIN_TOKEN_<SITE> or
 * .wrangler/tenants/<id>/.admin-token (written by
 * `pnpm deploy:ledger -- --site <id> --bootstrap-secrets`).
 *
 * Environment:
 *   LEDGER_ADMIN_TOKEN     administrator token of the target Ledger
 *                          (falls back to .wrangler/tenants/.admin-token)
 *   LEDGER_BASE_URL        optional URL override (default derived from
 *                          the Ledger Worker's name)
 *   CLOUDFLARE_API_TOKEN   Workers Scripts:Edit (for secret bulk/R2) and
 *                          "Access: Apps and Policies -> Edit",
 *                          "Access: Service Tokens -> Edit" and
 *                          "Access: Organizations, Identity Providers, and Groups -> Edit"
 *                          (plus
 *                          "Account Settings -> Read" unless
 *                          CLOUDFLARE_ACCOUNT_ID is set)
 *   CLOUDFLARE_ACCOUNT_ID  optional when the token can list accounts
 *   INVOICE_RENDERER_TOKEN optional; pushed as the Worker's renderer credential
 *   INVOICE_EXTRACTION_API_KEY / INVOICE_EXTRACTION_SERVICE_ACCOUNT
 *
 * Usage:
 *   pnpm ensure:tenant -- --site st
 *   pnpm ensure:tenant -- --site st --set-secret
 *   pnpm ensure:tenant -- --site st --rotate-token
 *   pnpm ensure:tenant -- --site st --apply-policy   # enforce the site's event policy on its existing Ledger app
 *   pnpm ensure:tenant -- --site alpha --create-integration-token iphone-steps
 *   pnpm ensure:tenant -- --dry-run
 *   pnpm provision:tenants                    # every site, same script
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import { dirname, join } from "node:path";

import { siteEventPolicy } from "./event-policy.js";
import {
	defaultConcurrency,
	mapWithConcurrency,
	parseConcurrency,
} from "./async-utils.js";
import {
	ACCESS_TOKEN_REQUIREMENT,
	ALLOW_POLICY_NAME,
	CloudflareAccessClient,
	extractPolicyEmails,
	planAccessApps,
	planFeedBypassRemoval,
	planIntegrationsApp,
	planServiceAuthPolicy,
	type AccessSiteInput,
	type ExistingAccessApp,
	type ExistingAccessPolicy,
} from "./cloudflare-access.js";
import { integrationTokenName } from "@hearthlog/contracts/integrations/kinds";
import {
	runCommand,
	runCommandResult,
	runWrangler,
	WRANGLER_BIN,
	wranglerEnvironment,
} from "./deploy-runner.js";
import {
	legacyTenantCredentialPath,
	resolveLedgerAdminToken,
	resolveLedgerBaseUrl,
	tenantCredentialPath,
} from "./ledger-credential.js";
import { dedicatedLedgerBaseUrl, resolveDedicatedAdminToken } from "./dedicated-ledger.js";
import {
	infrastructureFor,
	loadTenantConfig,
	REPOSITORY_ROOT,
	sharedSites,
	siteById,
	TenantConfigError,
	type InfrastructureDefinition,
	type ResolvedSite,
} from "../tenants/tenant-config.js";
import {
	generateTenantWranglerConfigs,
	moduleBindings,
	serverDeclarations,
	resolveFrontendWranglerTarget,
} from "../tenants/wrangler-config.js";


interface AdminAppSummary {
	id: string;
	name: string;
	revokedAt: string | null;
}

interface AdminAppTokenResponse {
	app: AdminAppSummary;
	token: string;
}

interface StoredCredential {
	siteId: string;
	ledgerAppName: string;
	appId: string;
	token: string;
	storedAt: string;
	accessAppId?: string;
	accessAud?: string;
}

interface Options {
	site?: string;
	dryRun: boolean;
	rotateToken: boolean;
	/** Set the site's event policy on an application that already exists (new applications always get it). */
	applyPolicy: boolean;
	/** Integration id whose Access service token should be created and printed once. */
	createIntegrationToken?: string;
	setSecret: boolean;
	skipR2: boolean;
	skipAccess: boolean;
	skipLedger: boolean;
	skipSecrets: boolean;
	concurrency: number;
	help: boolean;
}

export function parseOptions(argv: string[]): Options {
	const options: Options = {
		site: undefined,
		dryRun: false,
		rotateToken: false,
		applyPolicy: false,
		setSecret: false,
		skipR2: false,
		skipAccess: false,
		skipLedger: false,
		skipSecrets: false,
		concurrency: defaultConcurrency(),
		help: false,
	};

	const readValue = (name: string, index: number): string => {
		const value = argv[index + 1]?.trim();
		if (!value) throw new Error(`${name} requires a value`);
		return value;
	};

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		switch (argument) {
			case "--":
				break;
			case "--site":
				options.site = readValue("--site", index);
				index += 1;
				break;
			case "--concurrency":
				options.concurrency = parseConcurrency(readValue("--concurrency", index));
				index += 1;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--rotate-token":
				options.rotateToken = true;
				break;
			case "--apply-policy":
				options.applyPolicy = true;
				break;
			case "--create-integration-token":
				options.createIntegrationToken = readValue("--create-integration-token", index);
				index += 1;
				break;
			case "--set-secret":
				options.setSecret = true;
				break;
			case "--skip-r2":
				options.skipR2 = true;
				break;
			case "--skip-access":
				options.skipAccess = true;
				break;
			case "--skip-ledger":
				options.skipLedger = true;
				break;
			case "--skip-secrets":
				options.skipSecrets = true;
				break;
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new Error(`Unknown option: ${argument}`);
		}
	}

	return options;
}

function usage(): string {
	return `Ensure tenants are registered and protected (R2, Cloudflare Access, Ledger, secrets).

Usage:
  pnpm ensure:tenant -- --site <id> [options]
  pnpm provision:tenants

Options:
  --site <id>          Only this site (default: every site)
  --set-secret         Push Worker secrets even when nothing was minted
  --rotate-token       Mint a replacement Ledger token (invalidates the old one)
  --create-integration-token <id>
                       Create the Access service token of one integration and
                       print its client id and secret once (needs --site)
  --skip-r2            Skip the R2 bucket phase
  --skip-access        Skip the Cloudflare Access phase
  --skip-ledger        Skip the Ledger registration phase
  --skip-secrets       Skip the Worker secret phase
  --concurrency <n>    Maximum parallel API operations
  --dry-run            Print the plan without mutating anything
  -h, --help           Show this help

CI note: an existing Ledger application is never rotated automatically. The
Worker keeps the token minted at bootstrap; use --rotate-token to replace it.`;
}

interface LedgerContext {
	baseUrl: string;
	adminToken: string;
	dryRun: boolean;
	rotate: boolean;
	api<T>(route: string, init?: { method?: string; body?: unknown }): Promise<T>;
}

interface TenantOutcome {
	siteId: string;
	appId: string;
	tokenMinted: boolean;
	accessAud?: string;
	integrationsAud?: string;
	secretsPushed: boolean;
}

/**
 * Ensure one tenant. Never rotates an existing application unless explicitly
 * asked, so repeat runs are safe to execute on every deploy.
 */
export async function ensureTenant(
	site: ResolvedSite,
	infrastructure: InfrastructureDefinition,
	options: Options,
	ledger: LedgerContext | null,
	accessClient: CloudflareAccessClient | null,
): Promise<TenantOutcome> {
	const hostname = site.hostname;
	const outcome: TenantOutcome = {
		siteId: site.id,
		appId: "",
		tokenMinted: false,
		secretsPushed: false,
	};

	// Access first: its audience is one of the secrets we may push.
	let accessAud: string | undefined;
	let integrationsAud: string | undefined;
	if (accessClient) {
		const access = await ensureAccess(site, hostname, accessClient, options, infrastructure.accessSessionDuration);
		accessAud = access.aud;
		integrationsAud = access.integrationsAud;
		outcome.accessAud = accessAud;
		outcome.integrationsAud = integrationsAud;
	}

	// Ledger second: mint only on bootstrap (or an explicit rotation).
	let ledgerToken: string | null = null;
	let appId = "";
	if (ledger) {
		const result = await ensureLedgerApp(site, ledger, options);
		ledgerToken = result.token;
		appId = result.appId;
		outcome.appId = appId;
		outcome.tokenMinted = result.minted;
	}

	// Secrets last: automatic on bootstrap/rotation, forced with --set-secret.
	if (ledger || accessClient) {
		const shouldPush =
			!options.skipSecrets && (options.setSecret || outcome.tokenMinted);
		if (shouldPush) {
			const secrets = await collectSecrets(
				site,
				infrastructure,
				ledgerToken,
				accessAud,
				integrationsAud,
				ledger?.adminToken,
			);
			if (Object.keys(secrets).length === 0) {
				console.log(`Site ${site.id}: no secrets to push.`);
			} else if (options.dryRun) {
				console.log(
					`[dry-run] Would push ${Object.keys(secrets).join(", ")} for site ${site.id}`,
				);
			} else {
				const target = await resolveFrontendWranglerTarget(site.id);
				await runWrangler(target.config, target.envKey, ["secret", "bulk"], {
					input: `${JSON.stringify(secrets)}\n`,
				});
				outcome.secretsPushed = true;
				console.log(`Site ${site.id}: pushed ${Object.keys(secrets).join(", ")}`);
			}
		}
	}

	if (!options.dryRun && outcome.tokenMinted && ledgerToken) {
		await storeCredential({
			siteId: site.id,
			ledgerAppName: site.ledgerAppName,
			appId,
			token: ledgerToken,
			storedAt: new Date().toISOString(),
			...(accessAud ? { accessAud } : {}),
		});
	}

	return outcome;
}

async function ensureAccess(
	site: ResolvedSite,
	hostname: string,
	client: CloudflareAccessClient,
	options: Options,
	sessionDuration?: string,
): Promise<{ aud?: string; integrationsAud?: string }> {
	const siteInput: AccessSiteInput = {
		id: site.id,
		title: site.title,
		hostname,
		authorizedEmails: site.authorizedEmails,
		integrations: site.integrations.map((integration) => integration.id),
	};
	const existingApps: ExistingAccessApp[] = await client.listApps();

	// Pass 1: adopt the existing application or create it.
	const firstPass = planAccessApps([siteInput], existingApps, new Map());
	const createAction = firstPass.find((action) => action.kind === "create-app");
	let app = firstPass.find((action) => action.kind === "adopt-app");
	if (createAction?.kind === "create-app") {
		if (options.dryRun) {
			console.log(
				`[dry-run] Would create Access application "${createAction.name}" for ${createAction.hostname}` +
					(sessionDuration ? ` with session duration ${sessionDuration}` : ''),
			);
			return {};
		}
		const created = await client.createApp(
			createAction.name,
			createAction.hostname,
			sessionDuration,
		);
		existingApps.push(created);
		app = {
			kind: "adopt-app",
			siteId: site.id,
			appId: created.id,
			aud: created.aud,
			name: created.name,
		};
		console.log(
			`Site ${site.id}: created Access application "${created.name}" for ${createAction.hostname}`,
		);
	}

	if (!app || app.kind !== "adopt-app") {
		return {};
	}

	if (sessionDuration) {
		await client.reconcileSessionDuration(`apps/${app.appId}`, sessionDuration, options.dryRun);
	}

	// Pass 2: reconcile the Allow policy to exactly the authorized emails, so
	// an email removed from tenants.json loses access on the next run.
	const policies: ExistingAccessPolicy[] = await client.listPolicies(app.appId);
	const policyAction = planAccessApps(
		[siteInput],
		existingApps,
		new Map([[app.appId, policies]]),
	).find((action) => action.kind === "reconcile-policy");
	if (policyAction?.kind === "reconcile-policy") {
		const replaced = new Set(
			policyAction.replacePolicyIds.flatMap((id) => {
				const policy = policies.find((candidate) => candidate.id === id);
				return policy ? extractPolicyEmails(policy.include) : [];
			}),
		);
		const added = policyAction.emails.filter((email) => !replaced.has(email));
		const removed = [...replaced].filter(
			(email) => !policyAction.emails.includes(email),
		);
		const changes: string[] = [];
		if (added.length > 0) changes.push(`allow ${added.join(", ")}`);
		if (removed.length > 0) changes.push(`deny ${removed.join(", ")}`);
		const summary =
			changes.length > 0 ? changes.join("; ") : "consolidate policies";

		if (options.dryRun) {
			console.log(
				`[dry-run] Would ${summary} in the Access Allow policy ` +
					`(app ${policyAction.appId})`,
			);
		} else if (policyAction.replacePolicyIds.length === 0) {
			await client.createAllowPolicy(policyAction.appId, policyAction.emails);
			console.log(
				`Site ${site.id}: created Access Allow policy for ${policyAction.emails.join(", ")}`,
			);
		} else {
			const [keep, ...drop] = policyAction.replacePolicyIds;
			if (keep !== undefined) {
				const kept = policies.find((policy) => policy.id === keep);
				await client.updateAllowPolicy(
					policyAction.appId,
					keep,
					kept?.name ?? ALLOW_POLICY_NAME,
					policyAction.emails,
					kept?.reusable === true,
				);
				for (const policyId of drop) {
					const dropped = policies.find((policy) => policy.id === policyId);
					await client.deletePolicy(
						policyAction.appId,
						policyId,
						dropped?.reusable === true,
					);
				}
				console.log(
					`Site ${site.id}: reconciled Access Allow policy (${summary})`,
				);
			}
		}
	}

	if (sessionDuration) {
		// Re-read after email reconciliation, which may replace or consolidate policies.
		const currentPolicies = options.dryRun ? policies : await client.listPolicies(app.appId);
		for (const policy of currentPolicies) {
			if (policy.decision.toLowerCase() === 'allow') {
				// Reusable policies are updated at the account scope, not the app scope.
				await client.reconcileSessionDuration(
					policy.reusable
						? `policies/${policy.id}`
						: `apps/${app.appId}/policies/${policy.id}`,
					sessionDuration,
					options.dryRun,
				);
			}
		}
	}

	// Pass 3: calendar feeds moved to their own Worker, so the path-scoped
	// Bypass application that once exposed them on this host is retired.
	for (const feedApp of planFeedBypassRemoval(siteInput, existingApps)) {
		if (options.dryRun) {
			console.log(`[dry-run] Would delete the retired Access application "${feedApp.name}" (${feedApp.domain})`);
			continue;
		}
		await client.deleteApp(feedApp.id);
		existingApps.splice(existingApps.indexOf(feedApp), 1);
		console.log(`Site ${site.id}: deleted the retired Access application "${feedApp.name}" (${feedApp.domain})`);
	}

	// Pass 4: service integrations get their own path-scoped application.
	const integrationsAud = await ensureIntegrationsAccess(site, siteInput, client, existingApps, options);

	if (!options.dryRun) {
		console.log(
			`Site ${site.id}: Access application ${app.appId} (${app.name}) protects ${hostname}`,
		);
	}
	return { aud: app.aud, ...(integrationsAud ? { integrationsAud } : {}) };
}

/**
 * Ensure the integrations application and its Service Auth policy. The policy
 * names exactly the service tokens of the site's integrations (by the name
 * `<site>/<integration>`), so removing an integration from tenants.json
 * removes its access on the next run. Returns the application's audience.
 */
async function ensureIntegrationsAccess(
	site: ResolvedSite,
	siteInput: AccessSiteInput,
	client: CloudflareAccessClient,
	existingApps: ExistingAccessApp[],
	options: Options,
): Promise<string | undefined> {
	const requested = options.createIntegrationToken;
	if (requested !== undefined && !site.integrations.some((integration) => integration.id === requested)) {
		throw new TenantConfigError(
			`Site ${site.id} has no integration "${requested}" (add it to tenants.json first)`,
		);
	}
	const action = planIntegrationsApp(siteInput, existingApps);
	if (!action) return undefined;

	let appId: string;
	let aud: string;
	if (action.kind === "adopt-integrations-app") {
		appId = action.appId;
		aud = action.aud;
	} else {
		if (options.dryRun) {
			console.log(`[dry-run] Would create Access application "${action.name}" for ${action.domain}`);
			return undefined;
		}
		// Service callers cannot log in: answer 401 instead of redirecting to a login page.
		const created = await client.createApp(action.name, action.domain, undefined, {
			service_auth_401_redirect: true,
		});
		existingApps.push(created);
		appId = created.id;
		aud = created.aud;
		console.log(`Site ${site.id}: created Access application "${created.name}" for ${action.domain}`);
	}

	let tokens = await client.listServiceTokens();
	for (const integration of site.integrations) {
		const name = integrationTokenName(site.id, integration.id);
		const existing = tokens.find((token) => token.name === name);
		if (requested === integration.id) {
			if (existing) {
				throw new TenantConfigError(
					`Service token "${name}" already exists. Delete it in Cloudflare Zero Trust ` +
						"(Access, Service Auth) before creating a replacement.",
				);
			}
			if (options.dryRun) {
				console.log(`[dry-run] Would create the Access service token "${name}"`);
			} else {
				const created = await client.createServiceToken(name);
				tokens = [...tokens, created];
				printServiceToken(site.id, integration.id, created.clientId, created.clientSecret, created.expiresAt);
			}
		}
	}

	const wantedIds = site.integrations.flatMap((integration) =>
		tokens.filter((token) => token.name === integrationTokenName(site.id, integration.id)).map((token) => token.id),
	);
	for (const integration of site.integrations) {
		const token = tokens.find((candidate) => candidate.name === integrationTokenName(site.id, integration.id));
		if (!token) {
			console.log(
				`Site ${site.id}: integration "${integration.id}" has no service token yet; ` +
					`run with --create-integration-token ${integration.id}.`,
			);
		} else if (integration.clientId !== token.clientId) {
			console.log(
				`Site ${site.id}: set clientId "${token.clientId}" on integration "${integration.id}" in ` +
					"tenants.json so the Worker accepts the token.",
			);
		}
	}

	const policies = await client.listPolicies(appId);
	const plan = planServiceAuthPolicy(wantedIds, policies);
	if (plan.kind === "none") return aud;
	if (options.dryRun) {
		console.log(`[dry-run] Would reconcile the Service Auth policy of app ${appId} to ${plan.tokenIds.length} token(s)`);
		return aud;
	}
	if (plan.kind === "create") {
		await client.createServiceAuthPolicy(appId, plan.tokenIds);
	} else {
		const kept = policies.find((policy) => policy.id === plan.policyId);
		await client.updateServiceAuthPolicy(
			appId,
			plan.policyId,
			plan.tokenIds,
			kept?.reusable === true,
		);
		for (const policyId of plan.dropPolicyIds) {
			const dropped = policies.find((policy) => policy.id === policyId);
			await client.deletePolicy(appId, policyId, dropped?.reusable === true);
		}
	}
	console.log(`Site ${site.id}: reconciled the Service Auth policy (${plan.tokenIds.length} token(s))`);
	return aud;
}

function printServiceToken(
	siteId: string,
	integrationId: string,
	clientId: string,
	clientSecret: string,
	expiresAt: string | null,
): void {
	console.log(
		`\nCreated Access service token for ${siteId}/${integrationId}.\n` +
			"The secret is shown once and cannot be read back. Put both values in the Shortcut\n" +
			"as the CF-Access-Client-Id and CF-Access-Client-Secret headers; do not save them in the repository.\n" +
			`  Client ID:     ${clientId}\n` +
			`  Client secret: ${clientSecret}\n` +
			`  Expires:       ${expiresAt ?? "unknown"}\n` +
			`Then set "clientId": "${clientId}" on the integration in tenants.json.\n`,
	);
}

async function ensureLedgerApp(
	site: ResolvedSite,
	ledger: LedgerContext,
	options: Options,
): Promise<{ token: string | null; minted: boolean; appId: string }> {
	const existing = await ledger.api<{ apps: AdminAppSummary[] }>(
		"/admin/v1/apps",
	);
	const registered = existing.apps.find(
		(app) => app.name === site.ledgerAppName && app.revokedAt === null,
	);

	if (registered && options.applyPolicy) {
		if (options.dryRun) {
			console.log(`[dry-run] Would set the event policy of Ledger app ${registered.id} for site ${site.id}`);
		} else {
			await ledger.api(`/admin/v1/apps/${registered.id}/policy`, { method: "PUT", body: siteEventPolicy(site) });
			console.log(`Site ${site.id}: set the event policy of Ledger app ${registered.id}`);
		}
	}

	if (registered && !options.rotateToken) {
		console.log(
			`Site ${site.id}: Ledger app "${site.ledgerAppName}" already registered (${registered.id}); keeping its token.`,
		);
		return { token: null, minted: false, appId: registered.id };
	}

	if (options.dryRun) {
		console.log(
			registered
				? `[dry-run] Would rotate the Ledger token for site ${site.id}`
				: `[dry-run] Would create Ledger app "${site.ledgerAppName}" for site ${site.id}`,
		);
		return { token: null, minted: false, appId: registered?.id ?? "" };
	}

	if (!registered) {
		const created = await ledger.api<AdminAppTokenResponse>("/admin/v1/apps", {
			method: "POST",
			body: { name: site.ledgerAppName, policy: siteEventPolicy(site) },
		});
		console.log(
			`Site ${site.id}: created Ledger app "${created.app.name}" (${created.app.id})`,
		);
		return { token: created.token, minted: true, appId: created.app.id };
	}

	const rotated = await ledger.api<AdminAppTokenResponse>(
		`/admin/v1/apps/${registered.id}/rotate-token`,
		{ method: "POST" },
	);
	console.log(`Site ${site.id}: rotated Ledger token for app ${registered.id}`);
	return { token: rotated.token, minted: true, appId: rotated.app.id };
}

/**
 * The Worker secrets of one site. A site with the Ledger administrator proxy (`admin`) gets the administrator token of
 * the Ledger its gateway is bound to: the shared Ledger's, or its own when it runs on its own stack. The operator's
 * `LEDGER_ADMIN_TOKEN` environment variable is only the fallback when no Ledger was contacted (`--skip-ledger`).
 */
export async function collectSecrets(
	site: Pick<ResolvedSite, "id" | "admin" | "integrations"> & Partial<Pick<ResolvedSite, "features">>,
	infrastructure: Pick<InfrastructureDefinition, "accessTeamDomain">,
	ledgerToken: string | null,
	accessAud: string | undefined,
	integrationsAud: string | undefined,
	ledgerAdminToken?: string,
): Promise<Record<string, string>> {
	const secrets: Record<string, string> = {
		CF_ACCESS_TEAM_DOMAIN: infrastructure.accessTeamDomain,
	};
	if (ledgerToken) secrets.LEDGER_AUTH_TOKEN = ledgerToken;
	if (accessAud) secrets.CF_ACCESS_APP_AUD = accessAud;
	if (integrationsAud) secrets.CF_ACCESS_INTEGRATIONS_AUD = integrationsAud;

	if (site.admin) {
		const adminToken = ledgerAdminToken?.trim() || process.env.LEDGER_ADMIN_TOKEN?.trim();
		if (adminToken) secrets.LEDGER_ADMIN_TOKEN = adminToken;
		const adminAud = process.env.CF_ACCESS_ADMIN_AUD?.trim();
		if (adminAud) secrets.CF_ACCESS_ADMIN_AUD = adminAud;
	}

	// The renderer's credential comes from the operator's environment; without one the renderer routes answer 503.
	const rendererToken = process.env.INVOICE_RENDERER_TOKEN?.trim();
	if (rendererToken) secrets.INVOICE_RENDERER_TOKEN = rendererToken;
	Object.assign(secrets, extractionSecretsFromEnvironment(), moduleSecretsFromEnvironment(site.id, serverDeclarations(site.features ?? [])));
	return secrets;
}

/** Site-scoped operator variables take precedence when provisioning several gateways. Values never enter generated files. */
export function moduleSecretsFromEnvironment(
    siteId: string,
    servers: ReadonlyArray<{ secrets?: ReadonlyArray<{ name: string }> }>,
    environment: Record<string, string | undefined> = process.env,
): Record<string, string> {
    const result: Record<string, string> = {};
    const suffix = siteId.toUpperCase().replace(/-/g, '_');
    for (const server of servers) for (const { name } of server.secrets ?? []) {
        const value = environment[`${name}_${suffix}`]?.trim() || environment[name]?.trim();
        if (!value) throw new TenantConfigError(`Site ${siteId}: supply ${name}_${suffix} (or ${name}) in the operator environment before setting module secrets`);
        result[name] = value;
    }
    return result;
}

/**
 * Vertex AI credentials for AI invoice reading. Absent credentials are not a
 * failure: the feature answers 503 and the UI hides itself.
 */
function extractionSecretsFromEnvironment(): Record<string, string> {
	const secrets: Record<string, string> = {};
	const apiKey = process.env.INVOICE_EXTRACTION_API_KEY?.trim();
	const serviceAccount = process.env.INVOICE_EXTRACTION_SERVICE_ACCOUNT?.trim();
	if (apiKey) secrets.INVOICE_EXTRACTION_API_KEY = apiKey;
	if (serviceAccount)
		secrets.INVOICE_EXTRACTION_SERVICE_ACCOUNT = serviceAccount;
	return secrets;
}

/**
 * Ensure the shared R2 buckets exist. Creation is idempotent: the deploy
 * matrix runs `ensure-tenant` once per site in parallel, so several processes
 * may race to create the same shared bucket. Cloudflare answers the losers
 * with code 10004 ("already exists, and you own it"), which is success here.
 * The same code without ownership means another account holds the name, which
 * must fail loudly.
 */
/**
 * The buckets the selected sites need: the core's calendar feed bucket, then
 * those their modules declare.
 */
export function requiredBuckets(
	infrastructure: InfrastructureDefinition,
	sites: readonly Pick<ResolvedSite, "features">[],
): string[] {
	const names = new Set([infrastructure.calendarFeedsBucket, `${infrastructure.ledgerWorker}-archive`]);
	for (const site of sites) {
		for (const { bucket_name } of moduleBindings(site.features, infrastructure).r2) names.add(bucket_name);
	}
	return [...names];
}

async function ensureR2Buckets(
	infrastructure: InfrastructureDefinition,
	sites: readonly ResolvedSite[],
	options: Options,
): Promise<void> {
	const bucketNames = requiredBuckets(infrastructure, sites);
	if (options.dryRun) {
		for (const name of bucketNames) {
			console.log(`[dry-run] Would ensure R2 bucket "${name}"`);
		}
		return;
	}
	for (const name of bucketNames) {
		const result = await runCommandResult(
			WRANGLER_BIN,
			["r2", "bucket", "create", name, "--env-file", devNull],
			{ env: wranglerEnvironment() },
		);
		if (result.code === 0) {
			console.log(`Created R2 bucket "${name}".`);
			continue;
		}
		const output = `${result.stdout}\n${result.stderr}`;
		if (isBucketAlreadyExistsError(output)) {
			console.log(`R2 bucket "${name}" already exists.`);
			continue;
		}
		throw new Error(
			`Failed to create R2 bucket "${name}" (exit code ${result.code}):\n${output.trim()}`,
		);
	}
}

/**
 * Cloudflare's raced-create answer: `[code: 10004]` plus the ownership
 * phrase. Both parts matter: a same-named bucket owned by another account
 * also reports 10004 but must not be treated as success.
 */
export function isBucketAlreadyExistsError(output: string): boolean {
	return (
		/code:\s*10004\b/i.test(output) &&
		/already exists/i.test(output) &&
		/you own it/i.test(output)
	);
}

async function readStoredCredential(
	siteId: string,
): Promise<StoredCredential | null> {
	try {
		return JSON.parse(
			await readFile(tenantCredentialPath(siteId), "utf8"),
		) as StoredCredential;
	} catch {
		try {
			return JSON.parse(
				await readFile(legacyTenantCredentialPath(siteId), "utf8"),
			) as StoredCredential;
		} catch {
			return null;
		}
	}
}

async function storeCredential(credential: StoredCredential): Promise<void> {
	const target = tenantCredentialPath(credential.siteId);
	await mkdir(dirname(target), { recursive: true, mode: 0o700 });
	const previous = await readStoredCredential(credential.siteId);
	const merged: StoredCredential = { ...previous, ...credential };
	await writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, {
		mode: 0o600,
	});
	console.log(`Stored credential for ${credential.siteId}`);
}

function ledgerContext(
	baseUrl: string,
	adminToken: string,
	options: Options,
): LedgerContext {
	return {
		baseUrl,
		adminToken,
		dryRun: options.dryRun,
		rotate: options.rotateToken,
		async api<T>(
			route: string,
			init: { method?: string; body?: unknown } = {},
		): Promise<T> {
			const response = await fetch(`${baseUrl}${route}`, {
				method: init.method ?? "GET",
				headers: {
					Authorization: `Bearer ${adminToken}`,
					...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				body: init.body === undefined ? undefined : JSON.stringify(init.body),
			});
			const payload: unknown = await response.json().catch(() => null);
			if (!response.ok) {
				throw new TenantConfigError(
					`${init.method ?? "GET"} ${route} failed with ${response.status}: ` +
						`${JSON.stringify(payload)}`,
				);
			}
			return payload as T;
		},
	};
}

export async function ensureTenants(options: Options): Promise<void> {
	if (options.rotateToken && !options.site) {
		throw new Error("--rotate-token requires --site <id>");
	}
	if (options.createIntegrationToken && !options.site) {
		throw new Error("--create-integration-token requires --site <id>");
	}
	if (options.createIntegrationToken && options.skipAccess) {
		throw new Error("--create-integration-token cannot run with --skip-access");
	}

	const { infrastructure: sharedInfrastructure, sites } = await loadTenantConfig();
	const selected = options.site ? [siteById(sites, options.site)] : sharedSites(sites);
	if (selected.length === 0) {
		throw new TenantConfigError("No sites are configured.");
	}
	if (!options.site) {
		for (const site of sites.filter((candidate) => candidate.deployment)) {
			console.log(`Skipping ${site.id}: it runs on its own stack; ensure it with --site ${site.id}.`);
		}
	}
	// Only one site can be selected together with its own stack.
	const ownStack = selected.length === 1 && selected[0]!.deployment ? selected[0]! : null;
	const infrastructure = ownStack ? infrastructureFor(ownStack, sharedInfrastructure) : sharedInfrastructure;

	await generateTenantWranglerConfigs();

	if (!options.skipR2) {
		await ensureR2Buckets(infrastructure, selected, options);
	}

	const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? "";
	let accessClient: CloudflareAccessClient | null = null;
	if (!options.skipAccess) {
		if (!cloudflareToken) {
			throw new Error(
				`Cloudflare Access cannot run without CLOUDFLARE_API_TOKEN (${ACCESS_TOKEN_REQUIREMENT}). ` +
					"Pass --skip-access for an explicitly Access-free run.",
			);
		}
		accessClient = new CloudflareAccessClient(
			cloudflareToken,
			process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || null,
		);
		// The team-wide SSO lifetime is an account setting; the shared sites own it,
		// so a run for a site on its own stack leaves it alone.
		if (infrastructure.accessGlobalSessionDuration && !ownStack) {
			await accessClient.reconcileSessionDuration(
				'organizations', infrastructure.accessGlobalSessionDuration, options.dryRun,
				infrastructure.accessTeamDomain,
			);
		}
	}

	let ledger: LedgerContext | null = null;
	if (!options.skipLedger && ownStack) {
		const variable = ownStack.id.toUpperCase().replace(/-/g, "_");
		const baseUrl = process.env[`LEDGER_BASE_URL_${variable}`]?.trim().replace(/\/$/, "")
			|| dedicatedLedgerBaseUrl(ownStack, sharedInfrastructure);
		const adminToken = await resolveDedicatedAdminToken(ownStack.id);
		if (!adminToken) {
			throw new Error(
				`No administrator token for the ${ownStack.id} Ledger: run ` +
					`pnpm deploy:ledger -- --site ${ownStack.id} --bootstrap-secrets first, ` +
					`set LEDGER_ADMIN_TOKEN_${variable}, or pass --skip-ledger.`,
			);
		}
		ledger = ledgerContext(baseUrl, adminToken, options);
	} else if (!options.skipLedger) {
		const baseUrl = resolveLedgerBaseUrl(
			process.env.LEDGER_BASE_URL,
			sharedInfrastructure.ledgerWorker,
			sharedInfrastructure.workersDevDomain,
		);
		const adminToken = await resolveLedgerAdminToken();
		if (!adminToken) {
			throw new Error(
				"No Ledger admin token: set LEDGER_ADMIN_TOKEN or create " +
					".wrangler/tenants/.admin-token, or pass --skip-ledger.",
			);
		}
		ledger = ledgerContext(baseUrl, adminToken, options);
	}

	const outcomes = await mapWithConcurrency(
		selected,
		options.concurrency,
		(site) => ensureTenant(site, infrastructure, options, ledger, accessClient),
	);

	console.log("\nTenant ensure complete:");
	for (const outcome of outcomes) {
		const notes = [
			outcome.appId ? `app ${outcome.appId}` : "no Ledger app",
			outcome.tokenMinted ? "token minted" : "token kept",
			outcome.accessAud ? "access ready" : "access skipped",
			outcome.secretsPushed ? "secrets pushed" : "secrets kept",
		];
		console.log(`  ${outcome.siteId}: ${notes.join(", ")}`);
	}
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const options = parseOptions(argv);
	if (options.help) {
		console.log(usage());
		return;
	}
	await ensureTenants(options);
}

const invokedPath = process.argv[1];
if (invokedPath?.endsWith("ensure-tenant.ts")) {
	main().catch((error: unknown) => {
		console.error(`\n${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
