/**
 * Tenant configuration loading, validation, and resolution for Node scripts.
 *
 * A site is defined in `tenants/<id>/tenant.json`. `tenants.json` at the repository root is optional: it holds
 * the shared stack's `infrastructure` and the `defaults` for the sites that use it, and a repository whose sites all
 * run on their own stacks has none. This module is the only place that reads and validates them;
 * `packages/tooling/src/generate/generate-tenant.ts` and `packages/tooling/src/check/check-tenant-config.ts` build on
 * it. It must stay free of browser-only imports: it runs under tsx in Node.
 *
 * Hostnames are the Cloudflare workers.dev defaults: a site's production
 * Worker is named after its id, so its URL is
 * `https://<id>.<infrastructure.workersDevDomain>`. An optional `hostname` override supports custom domains later.
 *
 * A site's directory `tenants/<id>/` holds its definition (`tenant.json`), optionally `deployment.json`, which
 * gives it its own stack, and `modules.lock.json`, which records the modules it ships. `tenants.json` may still
 * list sites in its `sites` array (the same fields as a `tenant.json`); a site named in both places is an error.
 *
 * A site with `tenants/<id>/deployment.json` runs on its own stack: its own
 * Ledger Worker, buckets, and public Workers, all named from the file's
 * `resourcePrefix`, in the account the file names. Every other site uses the
 * shared `infrastructure` block.
 */

import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostRoot } from "../root.js";

import {
    FEATURES,
    featureById,
    isFeatureId,
    type FeatureId,
} from "../../../contracts/src/features/registry.js";
import { IMPLICIT_FEATURE_IDS } from "../../../contracts/src/features/core.js";
import { AI_CAPABILITIES, isAiCapability, type AiCapability } from "../../../contracts/src/ai/capabilities.js";
import {
    INTEGRATION_KINDS,
    INTEGRATION_KIND_FEATURE,
    isIntegrationClientId,
    isIntegrationId,
    isIntegrationKind,
    isLogId,
    type IntegrationDefinition,
} from "../../../contracts/src/integrations/kinds.js";

export const REPOSITORY_ROOT = hostRoot();
export const TENANTS_FILE = join(REPOSITORY_ROOT, "tenants.json");
export const TENANTS_DIRECTORY = join(REPOSITORY_ROOT, "tenants");
export const DEVELOPER_PATH = "/developer";

export interface SiteTheme {
    /** Accent color as #rgb or #rrggbb; drives the derived palette. */
    accent?: string;
}

export interface SiteDefinition {
    stashMediaEndpoint?: string;
    stashMediaBucket?: string;
    stashMediaRegion?: string;
    stashMediaProxy?: string;

    id: string;
    ledgerAppName?: string;
    admin?: boolean;
    /**
     * Every email allowed through the site's Cloudflare Access application.
     * Must not be empty; entries are deduplicated case-insensitively and
     * become the Allow policy and the Worker's STOR_AUTHORIZED_EMAILS
     * variable.
     */
    authorizedEmails: string[];
    features?: FeatureId[];
    /** AI decision capabilities the site enables; none by default. */
    ai?: AiCapability[];
    /** Service sources that append to one log of this site; none by default. */
    integrations?: IntegrationDefinition[];
    home?: string;
    title?: string;
    developerNavVisible?: boolean;
    entitiesNavVisible?: boolean;
    /** Whether the site may create dynamic entity types (meta-entities). */
    dynamicEntities?: boolean;
    theme?: SiteTheme;
    hostname?: string;
}

export interface InfrastructureDefinition {
    /** Production Ledger worker behind the LEDGER service binding. */
    ledgerWorker: string;
    /** Private R2 bucket for cached invoice PDFs (bound on every site). */
    invoicePdfsBucket: string;
    /** Private R2 bucket for calendar feed registrations and ICS caches. */
    calendarFeedsBucket: string;
    /** Public Worker that serves calendar feeds on its own origin, with no Ledger credential. */
    calendarPublicWorker: string;
    calendarPublicOrigin: string;
    /** Private app-scoped immutable Gallery originals and derivatives. */
    galleryFilesBucket: string;
    /** Curated public copies; never contains private originals. */
    galleryPublicBucket: string;
    galleryPublicWorker: string;
    galleryPublicOrigin: string;
    /** Private S3-compatible video storage, provisioned separately by the site operator. */
    stashMediaEndpoint?: string;
    stashMediaBucket?: string;
    stashMediaRegion?: string;
    /** "1" streams playback through the gateway instead of redirecting to storage. */
    stashMediaProxy?: string;
    /** The account's workers.dev subdomain, for example `example.workers.dev`; Worker URLs derive from it. */
    workersDevDomain: string;
    /** The invoice renderer's HTTPS origin; Invoices answers 503 without one. */
    invoiceRendererOrigin?: string;
    /** The external food catalog's HTTPS origin; Health's catalog search is off without one. */
    kalApiOrigin?: string;
    /** Administrator email configured on every site's Worker. */
    ledgerAdminEmail: string;
    /** Shared Cloudflare Access team origin pushed to every site Worker. */
    accessTeamDomain: string;
    /** The Cloudflare account that holds the shared stack. */
    accountId?: string;
    /** Browser application and team-wide SSO lifetimes, in whole hours. */
    accessSessionDuration?: string;
    accessGlobalSessionDuration?: string;
    /**
     * The one site on the shared stack that sweeps its public Gallery bucket on a schedule (two sweepers would race).
     * Defaults to the first site on the shared stack by id.
     */
    gallerySweeper?: string;
}

/** `tenants/<site>/deployment.json`: a site that runs on its own stack. */
export interface SiteDeployment {
    /** Private S3-compatible video storage, provisioned separately by the site operator. */
    stashMediaEndpoint?: string;
    stashMediaBucket?: string;
    stashMediaRegion?: string;
    /** "1" streams playback through the gateway instead of redirecting to storage. */
    stashMediaProxy?: string;

    schemaVersion: 1;
    /**
     * Prefix of every resource the site owns, starting with the site id, for
     * example "jst-prod": `jst-prod-ledger`, `jst-prod-gallery-files`.
     */
    resourcePrefix: string;
    /** The site's Ledger Worker serves only this site. */
    ledger: "dedicated";
    /** The Cloudflare account the stack lives in; informational, checked against the CLI's login when it is set. */
    accountId?: string;
    /** The account's workers.dev subdomain when it differs from the shared infrastructure's. */
    workersDevDomain?: string;
    /** Cloudflare Access for this site, when its team differs from the shared infrastructure's. */
    authentication?: { provider: "cloudflare-access"; teamDomain: string };
    /** Account values the shared infrastructure otherwise supplies; a repository without `tenants.json` needs the first three. */
    ledgerAdminEmail?: string;
    invoiceRendererOrigin?: string;
    kalApiOrigin?: string;
    accessSessionDuration?: string;
    accessGlobalSessionDuration?: string;
}

export interface TenantFile {
    /** Editor hint pointing at tenants.schema.json (`pnpm generate:tenant-schema`). */
    $schema?: string;
    infrastructure?: InfrastructureDefinition;
    defaults?: Partial<
        Pick<
            SiteDefinition,
            | "features"
            | "home"
            | "title"
            | "developerNavVisible"
            | "entitiesNavVisible"
        >
    >;
    /** Sites defined here rather than in `tenants/<id>/tenant.json`. */
    sites?: SiteDefinition[];
}

export interface ResolvedSite {
    stashMediaEndpoint?: string;
    stashMediaBucket?: string;
    stashMediaRegion?: string;
    stashMediaProxy?: string;

    id: string;
    ledgerAppName: string;
    features: FeatureId[];
    ai: AiCapability[];
    integrations: IntegrationDefinition[];
    home: string;
    title: string;
    developerNavVisible: boolean;
    entitiesNavVisible: boolean;
    dynamicEntities: boolean;
    theme: SiteTheme;
    admin: boolean;
    /** Deduplicated case-insensitively, in declaration order. */
    authorizedEmails: string[];
    hostname: string;
    /** Set when `tenants/<id>/deployment.json` gives the site its own stack. */
    deployment: SiteDeployment | null;
    /** The site came from `tenants/<id>/tenant.json` rather than `tenants.json`. */
    fromTenantFile: boolean;
}

export class TenantConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TenantConfigError";
    }
}

const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TOP_LEVEL_KEYS = ["$schema", "infrastructure", "defaults", "sites"] as const;
const DEFAULTS_KEYS = ["features", "home", "title", "developerNavVisible", "entitiesNavVisible"] as const;
const SITE_KEYS = [
    "id",
    "ledgerAppName",
    "admin",
    "authorizedEmails",
    "features",
    "ai",
    "integrations",
    "home",
    "title",
    "developerNavVisible",
    "entitiesNavVisible",
    "dynamicEntities",
    "theme",
    "hostname",
    "stashMediaEndpoint", "stashMediaBucket", "stashMediaRegion", "stashMediaProxy",
] as const satisfies readonly (keyof SiteDefinition)[];
const DEPLOYMENT_KEYS = [
    "$schema", "schemaVersion", "resourcePrefix", "ledger", "accountId", "workersDevDomain", "authentication",
    "ledgerAdminEmail", "invoiceRendererOrigin", "kalApiOrigin", "accessSessionDuration", "accessGlobalSessionDuration",
    "stashMediaEndpoint", "stashMediaBucket", "stashMediaRegion", "stashMediaProxy",
] as const;
const TENANT_FILE_KEYS = ["$schema", "schemaVersion", ...SITE_KEYS] as const;
const WORKERS_DEV_PATTERN = /^[a-z0-9][a-z0-9-]*\.workers\.dev$/;
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const RESOURCE_PREFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const THEME_KEYS = ["accent"] as const satisfies readonly (keyof SiteTheme)[];
const INTEGRATION_KEYS = ["id", "kind", "logId", "clientId"] as const satisfies readonly (keyof IntegrationDefinition)[];
const REQUIRED_INFRASTRUCTURE_KEYS = [
    "ledgerWorker",
    "invoicePdfsBucket",
    "calendarFeedsBucket",
    "calendarPublicWorker",
    "calendarPublicOrigin",
    "galleryFilesBucket",
    "galleryPublicBucket",
    "galleryPublicWorker",
    "galleryPublicOrigin",
    "workersDevDomain",
    "ledgerAdminEmail",
    "accessTeamDomain",
] as const satisfies readonly (keyof InfrastructureDefinition)[];
const INFRASTRUCTURE_KEYS = [
    ...REQUIRED_INFRASTRUCTURE_KEYS,
    "invoiceRendererOrigin",
    "kalApiOrigin",
    "accessSessionDuration",
    "accessGlobalSessionDuration",
    "gallerySweeper",
    "stashMediaEndpoint", "stashMediaBucket", "stashMediaRegion", "stashMediaProxy",
    "accountId",
] as const satisfies readonly (keyof InfrastructureDefinition)[];

/** Reject keys the loader would silently ignore, such as a misspelt "titel". */
function rejectUnknownKeys(label: string, value: unknown, known: readonly string[]): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TenantConfigError(`${label} must be an object`);
    }
    for (const key of Object.keys(value)) {
        if (!known.includes(key)) {
            throw new TenantConfigError(
                `${label}: unknown key "${key}" (known keys: ${known.join(", ")})`,
            );
        }
    }
}

function featurePath(featureId: FeatureId): string {
    return featureById(featureId).page?.path ?? "/";
}

function isPathEnabled(
    features: readonly FeatureId[],
    path: string,
): boolean {
    if (path === "/") return true;
    if (path === DEVELOPER_PATH) return true;
    return features.some((id) => featurePath(id) === path);
}

/** Which stack a site runs on, known without resolving it: a build resolves only its own site. */
export interface SiteStack {
    id: string;
    shared: boolean;
}

/**
 * Stands in for the shared infrastructure when there is no `tenants.json`. Every site then has a
 * `deployment.json`, which supplies all it needs, so none of these empty names is ever read.
 */
const NO_SHARED_INFRASTRUCTURE: InfrastructureDefinition = Object.fromEntries(
    REQUIRED_INFRASTRUCTURE_KEYS.map((key) => [key, ""]),
) as unknown as InfrastructureDefinition;

/** Parse, validate, and resolve `tenants.json` (when there is one) and the sites in `tenants/`. */
export async function loadTenantConfig(
    filePath: string = TENANTS_FILE,
    /** `only` resolves and validates one site: a build knows the modules of its own site only. */
    options: { only?: string } = {},
): Promise<{
    raw: TenantFile;
    infrastructure: InfrastructureDefinition;
    sites: ResolvedSite[];
    /** The stack of every site, including those `only` leaves unresolved. */
    stacks: SiteStack[];
}> {
    let raw: TenantFile;
    let shared = true;
    try {
        raw = JSON.parse(await readFile(filePath, "utf8")) as TenantFile;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new TenantConfigError(
                `Cannot read tenant config at ${filePath}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        raw = { sites: [] };
        shared = false;
    }
    rejectUnknownKeys("tenants.json", raw, TOP_LEVEL_KEYS);
    if (raw.defaults !== undefined) {
        rejectUnknownKeys("tenants.json defaults", raw.defaults, DEFAULTS_KEYS);
    }
    if (raw.sites !== undefined && !Array.isArray(raw.sites)) {
        throw new TenantConfigError('tenants.json "sites" must be an array');
    }
    const infrastructure = shared ? resolveInfrastructure(raw) : NO_SHARED_INFRASTRUCTURE;
    const definitions: Array<{ site: SiteDefinition; fromTenantFile: boolean }> = (raw.sites ?? []).map((site) => ({ site, fromTenantFile: false }));
    const tenantsDirectory = filePath === TENANTS_FILE ? TENANTS_DIRECTORY : join(dirname(filePath), "tenants");
    for (const site of await loadTenantFiles(tenantsDirectory)) {
        if (definitions.some((existing) => existing.site.id === site.id)) {
            throw new TenantConfigError(`Site "${site.id}" is defined in both tenants.json and tenants/${site.id}/tenant.json`);
        }
        definitions.push({ site, fromTenantFile: true });
    }
    const sites: ResolvedSite[] = [];
    const stacks: SiteStack[] = [];
    for (const { site, fromTenantFile } of definitions) {
        const own = await access(siteDeploymentPath(site.id, tenantsDirectory)).then(() => true, () => false);
        stacks.push({ id: site.id, shared: !own });
        if (!shared && !own) {
            throw new TenantConfigError(
                `Site "${site.id}" has no tenants/${site.id}/deployment.json and there is no tenants.json to give it shared infrastructure`,
            );
        }
        if (options.only !== undefined && site.id !== options.only) continue;
        // A build holds the modules of its own site only (VITE_STOR_TENANT), so only that site is checked against them.
        const active = process.env.VITE_STOR_TENANT?.trim();
        const resolved = resolveSite(raw.defaults, site, infrastructure.workersDevDomain, { lenient: Boolean(active) && site.id !== active });
        const deployment = await loadSiteDeployment(resolved, tenantsDirectory, { standalone: !shared });
        // An account of its own brings its own workers.dev subdomain, unless the site names a hostname.
        const domain = deployment?.workersDevDomain;
        sites.push({
            ...resolved,
            deployment,
            fromTenantFile,
            hostname: site.hostname ?? (domain ? `https://${site.id}.${domain}` : resolved.hostname),
        });
    }
    if (infrastructure.gallerySweeper !== undefined && !stacks.some((stack) => stack.shared && stack.id === infrastructure.gallerySweeper)) {
        throw new TenantConfigError(`tenants.json infrastructure.gallerySweeper "${infrastructure.gallerySweeper}" is not a site on the shared stack`);
    }
    return { raw, infrastructure, sites, stacks };
}

/**
 * The shared stack's one site that sweeps its public Gallery bucket on a schedule: the configured one, else the
 * first by id. Sites on their own stacks sweep their own buckets.
 */
export function gallerySweeperId(stacks: readonly SiteStack[], infrastructure: Pick<InfrastructureDefinition, "gallerySweeper">): string | undefined {
    return infrastructure.gallerySweeper ?? stacks.filter((stack) => stack.shared).map((stack) => stack.id).sort()[0];
}

/** `tenants/<id>/tenant.json` files: a site's definition kept next to its deployment file. */
async function loadTenantFiles(directory: string): Promise<SiteDefinition[]> {
    let names: string[];
    try {
        names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch {
        return [];
    }
    const definitions: SiteDefinition[] = [];
    for (const name of names) {
        const path = join(directory, name, "tenant.json");
        let value: unknown;
        try {
            value = JSON.parse(await readFile(path, "utf8"));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new TenantConfigError(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const label = `tenants/${name}/tenant.json`;
        rejectUnknownKeys(label, value, TENANT_FILE_KEYS);
        const { schemaVersion, $schema: _schema, ...site } = value as { schemaVersion?: unknown; $schema?: unknown } & SiteDefinition;
        if (schemaVersion !== 1) throw new TenantConfigError(`${label}: schemaVersion must be 1`);
        if (site.id !== name) throw new TenantConfigError(`${label}: id must be "${name}", the name of its directory`);
        definitions.push(site);
    }
    return definitions;
}

/** The loaded site with this id; throws when the id is unknown. */
export function siteById(sites: readonly ResolvedSite[], siteId: string): ResolvedSite {
    const site = sites.find((candidate) => candidate.id === siteId);
    if (!site) {
        throw new TenantConfigError(
            `Unknown site id "${siteId}" (known ids: ${sites.map((candidate) => candidate.id).join(", ")})`,
        );
    }
    return site;
}

export function siteDeploymentPath(siteId: string, directory: string = TENANTS_DIRECTORY): string {
    return join(directory, siteId, "deployment.json");
}

/** Read and validate `tenants/<id>/deployment.json`; null when the site has none. */
export async function loadSiteDeployment(
    site: ResolvedSite,
    directory: string = TENANTS_DIRECTORY,
    /** No `tenants.json`: the file must then carry the account values the shared infrastructure would. */
    options: { standalone?: boolean } = {},
): Promise<SiteDeployment | null> {
    const path = siteDeploymentPath(site.id, directory);
    try {
        await access(path);
    } catch {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
        throw new TenantConfigError(
            `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    return parseSiteDeployment(site, value, options);
}

export function parseSiteDeployment(
    site: Pick<ResolvedSite, "id">,
    value: unknown,
    options: { standalone?: boolean } = {},
): SiteDeployment {
    const label = `tenants/${site.id}/deployment.json`;
    rejectUnknownKeys(label, value, DEPLOYMENT_KEYS);
    const deployment = value as Partial<SiteDeployment>;
    if (deployment.schemaVersion !== 1) {
        throw new TenantConfigError(`${label}: schemaVersion must be 1`);
    }
    const prefix = deployment.resourcePrefix;
    if (typeof prefix !== "string" || !RESOURCE_PREFIX_PATTERN.test(prefix) || !prefix.startsWith(`${site.id}-`)) {
        throw new TenantConfigError(
            `${label}: resourcePrefix must start with "${site.id}-" and use lowercase letters, digits, and hyphens (up to 40 characters)`,
        );
    }
    if (deployment.ledger !== "dedicated") {
        throw new TenantConfigError(`${label}: ledger must be "dedicated"`);
    }
    const result: SiteDeployment = { schemaVersion: 1, resourcePrefix: prefix, ledger: "dedicated" };
    if (deployment.accountId !== undefined) {
        if (typeof deployment.accountId !== "string" || !ACCOUNT_ID_PATTERN.test(deployment.accountId)) {
            throw new TenantConfigError(`${label}: accountId must be a 32-character hexadecimal Cloudflare account id`);
        }
        result.accountId = deployment.accountId;
    }
    if (deployment.workersDevDomain !== undefined) {
        if (typeof deployment.workersDevDomain !== "string" || !WORKERS_DEV_PATTERN.test(deployment.workersDevDomain)) {
            throw new TenantConfigError(`${label}: workersDevDomain must look like "your-subdomain.workers.dev"`);
        }
        result.workersDevDomain = deployment.workersDevDomain;
    }
    if (deployment.authentication !== undefined) {
        rejectUnknownKeys(`${label} authentication`, deployment.authentication, ["provider", "teamDomain"]);
        if (deployment.authentication.provider !== "cloudflare-access") {
            throw new TenantConfigError(`${label}: authentication.provider must be "cloudflare-access"`);
        }
        requireHttpsOrigin(`${label} authentication.teamDomain`, deployment.authentication.teamDomain);
        result.authentication = { provider: "cloudflare-access", teamDomain: deployment.authentication.teamDomain };
    }
    if (deployment.ledgerAdminEmail !== undefined) {
        if (typeof deployment.ledgerAdminEmail !== "string" || !EMAIL_PATTERN.test(deployment.ledgerAdminEmail)) {
            throw new TenantConfigError(`${label}: ledgerAdminEmail must be an email address`);
        }
        result.ledgerAdminEmail = deployment.ledgerAdminEmail;
    }
    for (const key of ["invoiceRendererOrigin", "kalApiOrigin"] as const) {
        const origin = deployment[key];
        if (origin === undefined) continue;
        requireHttpsOrigin(`${label} ${key}`, origin);
        result[key] = origin;
    }
    for (const key of ["accessSessionDuration", "accessGlobalSessionDuration"] as const) {
        const duration = deployment[key];
        if (duration === undefined) continue;
        requireSessionDuration(`${label} ${key}`, duration);
        result[key] = duration;
    }
    Object.assign(result, parseStashMediaConfiguration(deployment, label));
    if (options.standalone) {
        for (const key of ["workersDevDomain", "ledgerAdminEmail", "authentication"] as const) {
            if (result[key] === undefined) throw new TenantConfigError(`${label}: ${key} is required when there is no tenants.json`);
        }
    }
    return result;
}

/** Validate optional media settings without requiring storage for sites that do not enable it. */
export function parseStashMediaConfiguration(value: Partial<InfrastructureDefinition>, label: string): Partial<InfrastructureDefinition> {
    const result: Partial<InfrastructureDefinition> = {};
    for (const key of ['stashMediaEndpoint', 'stashMediaBucket', 'stashMediaRegion', 'stashMediaProxy'] as const) {
        const text = value[key];
        if (text === undefined) continue;
        if (typeof text !== 'string' || !text.trim()) throw new TenantConfigError(`${label}.${key} must be a non-empty string`);
        if (key === 'stashMediaEndpoint') requireHttpsOrigin(`${label}.${key}`, text);
        if (key === 'stashMediaBucket' && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(text)) throw new TenantConfigError(`${label}.${key} must be an S3 bucket name`);
        if (key === 'stashMediaRegion' && !/^[a-z0-9-]+$/.test(text)) throw new TenantConfigError(`${label}.${key} must be an S3 region`);
        if (key === 'stashMediaProxy' && !['0', '1'].includes(text)) throw new TenantConfigError(`${label}.${key} must be 0 or 1`);
        result[key] = text;
    }
    return result;
}

function requireSessionDuration(label: string, duration: unknown): asserts duration is string {
    if (typeof duration !== "string" || !/^[1-9]\d*h$/.test(duration) || Number(duration.slice(0, -1)) > 720) {
        throw new TenantConfigError(`${label} must be whole hours between 1h and 720h`);
    }
}

function requireHttpsOrigin(label: string, value: unknown): asserts value is string {
    let url: URL | null = null;
    try {
        url = typeof value === "string" ? new URL(value) : null;
    } catch {
        url = null;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
        throw new TenantConfigError(`${label} must be an HTTPS origin`);
    }
}

/** The workers.dev subdomain a site's Workers live under: its own account's, else the shared one. */
export function workersDevDomainFor(site: Pick<ResolvedSite, "deployment">, shared: Pick<InfrastructureDefinition, "workersDevDomain">): string {
    return site.deployment?.workersDevDomain ?? shared.workersDevDomain;
}

/**
 * The resources a site's Workers bind to. A site on its own stack derives
 * every name from its resource prefix. Account-wide settings stay shared.
 */
export function infrastructureFor(
    site: Pick<ResolvedSite, "deployment"> & Partial<Pick<ResolvedSite, "stashMediaEndpoint" | "stashMediaBucket" | "stashMediaRegion" | "stashMediaProxy">>,
    shared: InfrastructureDefinition,
): InfrastructureDefinition {
    if (!site.deployment) return { ...shared, ...parseStashMediaConfiguration(site, "site") };
    const prefix = site.deployment.resourcePrefix;
    const origin = (worker: string) => `https://${worker}.${workersDevDomainFor(site, shared)}`;
    const names = {
        ledgerWorker: `${prefix}-ledger`,
        invoicePdfsBucket: `${prefix}-invoice-pdfs`,
        calendarFeedsBucket: `${prefix}-calendar-feeds`,
        calendarPublicWorker: `${prefix}-calendar-public`,
        calendarPublicOrigin: origin(`${prefix}-calendar-public`),
        galleryFilesBucket: `${prefix}-gallery-files`,
        galleryPublicBucket: `${prefix}-gallery-public`,
        galleryPublicWorker: `${prefix}-gallery-public`,
        galleryPublicOrigin: origin(`${prefix}-gallery-public`),
    };
    return {
        ...shared,
        ...names,
        ...parseStashMediaConfiguration(site.deployment, "site deployment"),
        ...parseStashMediaConfiguration(site, "site"),
        workersDevDomain: workersDevDomainFor(site, shared),
        ...(site.deployment.authentication ? { accessTeamDomain: site.deployment.authentication.teamDomain } : {}),
        ...(site.deployment.ledgerAdminEmail ? { ledgerAdminEmail: site.deployment.ledgerAdminEmail } : {}),
        ...(site.deployment.invoiceRendererOrigin ? { invoiceRendererOrigin: site.deployment.invoiceRendererOrigin } : {}),
        ...(site.deployment.kalApiOrigin ? { kalApiOrigin: site.deployment.kalApiOrigin } : {}),
        ...(site.deployment.accessSessionDuration ? { accessSessionDuration: site.deployment.accessSessionDuration } : {}),
        ...(site.deployment.accessGlobalSessionDuration ? { accessGlobalSessionDuration: site.deployment.accessGlobalSessionDuration } : {}),
    };
}

/** Sites served by the shared Ledger, buckets, and public Workers. */
export function sharedSites(sites: readonly ResolvedSite[]): ResolvedSite[] {
    return sites.filter((site) => !site.deployment);
}

/** Validate one site definition and resolve it against the defaults. */
export function resolveSite(
    defaults: TenantFile["defaults"] | undefined,
    site: SiteDefinition,
    workersDevDomain: string,
    /**
     * Another site's features may be unknown to the catalog this build holds (it has only its own site's modules): keep
     * them as written and skip the checks that need them.
     */
    options: { lenient?: boolean } = {},
): ResolvedSite {
    const label = `site "${site.id ?? "<missing id>"}"`;
    rejectUnknownKeys(label, site, SITE_KEYS);
    if (site.theme !== undefined) rejectUnknownKeys(`${label} theme`, site.theme, THEME_KEYS);
    if (!site.id || !SITE_ID_PATTERN.test(site.id)) {
        throw new TenantConfigError(
            `${label}: id must match ${SITE_ID_PATTERN} (it becomes the ` +
                `wrangler env name, the Worker name, and the workers.dev ` +
                `hostname)`,
        );
    }
    if (!site.authorizedEmails || site.authorizedEmails.length === 0) {
        throw new TenantConfigError(
            `${label}: authorizedEmails must list at least one email address`,
        );
    }

    const seenEmails = new Set<string>();
    const authorizedEmails: string[] = [];
    for (const email of site.authorizedEmails) {
        if (!EMAIL_PATTERN.test(email)) {
            throw new TenantConfigError(
                `${label}: authorizedEmails entry "${email}" is not a valid email address`,
            );
        }
        const key = email.toLowerCase();
        if (seenEmails.has(key)) {
            throw new TenantConfigError(
                `${label}: authorizedEmails contains a duplicate entry "${email}"`,
            );
        }
        seenEmails.add(key);
        authorizedEmails.push(email);
    }

    const listed = site.features ?? defaults?.features;
    if (!listed) {
        throw new TenantConfigError(`${label}: features must be listed (an empty list is fine: Calendar is always on)`);
    }
    for (const featureId of listed) {
        if (!options.lenient && !isFeatureId(featureId)) {
            throw new TenantConfigError(
                `${label}: unknown feature id "${featureId}" (known ids: ` +
                    `${FEATURES.map((feature) => feature.id).join(", ")})`,
            );
        }
    }
    if (new Set(listed).size !== listed.length) {
        throw new TenantConfigError(`${label}: duplicate feature ids`);
    }
    // Implicit features are always on, whether or not the list names them.
    const features = [...listed.filter((id) => !(IMPLICIT_FEATURE_IDS as readonly string[]).includes(id)), ...IMPLICIT_FEATURE_IDS];

    const ai = site.ai ?? [];
    for (const capability of ai) {
        if (!options.lenient && !isAiCapability(capability)) {
            throw new TenantConfigError(
                `${label}: unknown ai capability "${capability}" (known ids: ` +
                    `${AI_CAPABILITIES.join(", ")})`,
            );
        }
    }
    if (new Set(ai).size !== ai.length) {
        throw new TenantConfigError(`${label}: duplicate ai capabilities`);
    }

    const integrations = resolveIntegrations(label, site.integrations ?? [], features);

    const home = site.home ?? defaults?.home ?? "/";
    if (!options.lenient && !isPathEnabled(features, home)) {
        throw new TenantConfigError(
            `${label}: home "${home}" is not an enabled feature of this site`,
        );
    }

    const title = site.title ?? defaults?.title ?? "stor";
    const developerNavVisible =
        site.developerNavVisible ?? defaults?.developerNavVisible ?? true;
    const entitiesNavVisible =
        site.entitiesNavVisible ?? defaults?.entitiesNavVisible ?? true;
    const dynamicEntities = site.dynamicEntities ?? false;

    const theme: SiteTheme = {};
    const accent = site.theme?.accent;
    if (accent !== undefined) {
        if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(accent)) {
            throw new TenantConfigError(
                `${label}: theme.accent "${accent}" must be a #rgb or #rrggbb color`,
            );
        }
        theme.accent = accent.toLowerCase();
    }

    const hostname = site.hostname ?? `https://${site.id}.${workersDevDomain}`;

    return {
        id: site.id,
        ledgerAppName: site.ledgerAppName ?? site.id,
        ...parseStashMediaConfiguration(site, label),
        features: [...features],
        ai: [...ai],
        integrations,
        home,
        title,
        developerNavVisible,
        entitiesNavVisible,
        dynamicEntities,
        theme,
        admin: site.admin ?? false,
        authorizedEmails,
        hostname,
        deployment: null,
        fromTenantFile: false,
    };
}

function resolveIntegrations(
    label: string,
    integrations: readonly IntegrationDefinition[],
    features: readonly FeatureId[],
): IntegrationDefinition[] {
    const resolved: IntegrationDefinition[] = [];
    const seenIds = new Set<string>();
    const seenClients = new Set<string>();
    for (const integration of integrations) {
        const name = `${label}: integration "${integration?.id ?? "<missing id>"}"`;
        rejectUnknownKeys(name, integration, INTEGRATION_KEYS);
        if (!isIntegrationId(integration?.id)) {
            throw new TenantConfigError(
                `${name}: id must be lowercase letters, digits and hyphens (up to 40 characters)`,
            );
        }
        if (seenIds.has(integration.id)) {
            throw new TenantConfigError(`${name}: duplicate integration id`);
        }
        seenIds.add(integration.id);
        if (!isIntegrationKind(integration.kind)) {
            throw new TenantConfigError(
                `${name}: unknown kind "${String(integration.kind)}" (known kinds: ` +
                    `${INTEGRATION_KINDS.join(", ")})`,
            );
        }
        const requiredFeature = INTEGRATION_KIND_FEATURE[integration.kind];
        if (!features.includes(requiredFeature)) {
            throw new TenantConfigError(
                `${name}: kind "${integration.kind}" needs the "${requiredFeature}" feature enabled`,
            );
        }
        if (!isLogId(integration.logId)) {
            throw new TenantConfigError(`${name}: logId must be a UUID`);
        }
        if (integration.clientId !== undefined) {
            if (!isIntegrationClientId(integration.clientId)) {
                throw new TenantConfigError(`${name}: clientId is not a valid Access service-token client id`);
            }
            if (seenClients.has(integration.clientId)) {
                throw new TenantConfigError(`${name}: clientId is already used by another integration`);
            }
            seenClients.add(integration.clientId);
        }
        resolved.push({
            id: integration.id,
            kind: integration.kind,
            logId: integration.logId.toLowerCase(),
            ...(integration.clientId ? { clientId: integration.clientId } : {}),
        });
    }
    return resolved;
}

/** Resolve one site by id; throws when the id is unknown. */
export function resolveSiteById(
    raw: TenantFile,
    siteId: string,
): ResolvedSite {
    const site = (raw.sites ?? []).find((candidate) => candidate.id === siteId);
    if (!site) {
        throw new TenantConfigError(
            `Unknown site id "${siteId}" (known ids: ` +
                `${(raw.sites ?? []).map((candidate) => candidate.id).join(", ")})`,
        );
    }
    return resolveSite(raw.defaults, site, resolveInfrastructure(raw).workersDevDomain);
}

/** Validate the shared infrastructure identifiers. */
export function resolveInfrastructure(
    raw: TenantFile,
): InfrastructureDefinition {
    const infrastructure = raw.infrastructure;
    if (!infrastructure) {
        throw new TenantConfigError(
            "tenants.json is missing the required \"infrastructure\" block " +
                "(ledgerWorker, invoicePdfsBucket, calendarFeedsBucket, " +
                "calendarPublicWorker, calendarPublicOrigin, galleryFilesBucket, " +
                "galleryPublicBucket, galleryPublicWorker, galleryPublicOrigin, " +
                "workersDevDomain, ledgerAdminEmail, " +
                "accessTeamDomain)",
        );
    }
    rejectUnknownKeys("tenants.json infrastructure", infrastructure, INFRASTRUCTURE_KEYS);
    for (const key of REQUIRED_INFRASTRUCTURE_KEYS) {
        const value = infrastructure[key];
        if (typeof value !== "string" || value.trim() === "") {
            throw new TenantConfigError(
                `tenants.json infrastructure.${key} must be a non-empty string`,
            );
        }
        if (
            key === "accessTeamDomain" ||
            key === "galleryPublicOrigin" ||
            key === "calendarPublicOrigin"
        ) {
            let url: URL;
            try {
                url = new URL(value);
            } catch {
                throw new TenantConfigError(
                    `tenants.json infrastructure.${key} must be an ` +
                        "HTTPS origin",
                );
            }
            if (
                url.protocol !== "https:" ||
                url.username ||
                url.password ||
                url.search ||
                url.hash ||
                url.pathname !== "/"
            ) {
                throw new TenantConfigError(
                    `tenants.json infrastructure.${key} must be an ` +
                        "HTTPS origin",
                );
            }
        }
    }
    if (!WORKERS_DEV_PATTERN.test(infrastructure.workersDevDomain)) {
        throw new TenantConfigError('tenants.json infrastructure.workersDevDomain must look like "your-subdomain.workers.dev"');
    }
    if (infrastructure.invoiceRendererOrigin !== undefined) {
        requireHttpsOrigin("tenants.json infrastructure.invoiceRendererOrigin", infrastructure.invoiceRendererOrigin);
    }
    if (infrastructure.kalApiOrigin !== undefined) {
        requireHttpsOrigin("tenants.json infrastructure.kalApiOrigin", infrastructure.kalApiOrigin);
    }
    if (infrastructure.accountId !== undefined && (typeof infrastructure.accountId !== "string" || !ACCOUNT_ID_PATTERN.test(infrastructure.accountId))) {
        throw new TenantConfigError("tenants.json infrastructure.accountId must be a 32-character hexadecimal Cloudflare account id");
    }
    for (const key of ['accessSessionDuration', 'accessGlobalSessionDuration'] as const) {
        const duration = infrastructure[key];
        if (duration !== undefined) requireSessionDuration(`tenants.json infrastructure.${key}`, duration);
    }
    parseStashMediaConfiguration(infrastructure, "tenants.json infrastructure");
    return infrastructure;
}

/**
 * A site on its own stack must not reuse a name of the shared stack or of
 * another site's stack: a binding would then reach someone else's data.
 */
export function validateDeploymentIsolation(
    sites: readonly ResolvedSite[],
    shared: InfrastructureDefinition,
): void {
    const resourceKeys = [
        "ledgerWorker", "invoicePdfsBucket", "calendarFeedsBucket", "calendarPublicWorker",
        "galleryFilesBucket", "galleryPublicBucket", "galleryPublicWorker",
    ] as const;
    const owners = new Map<string, string>();
    const claim = (name: string, owner: string) => {
        const existing = owners.get(name);
        if (existing && existing !== owner) {
            throw new TenantConfigError(`Resource "${name}" is used by both ${existing} and ${owner}`);
        }
        owners.set(name, owner);
    };
    for (const key of resourceKeys) claim(shared[key], "the shared infrastructure");
    for (const site of sites) {
        if (!site.deployment) continue;
        const own = infrastructureFor(site, shared);
        for (const key of resourceKeys) claim(own[key], `site "${site.id}"`);
        for (const other of sites) {
            if (other.id !== site.id && (other.hostname === site.hostname || other.id === own.ledgerWorker)) {
                throw new TenantConfigError(`Site "${site.id}" collides with site "${other.id}"`);
            }
        }
    }
}

/** Cross-site consistency checks beyond per-site validation. */
export function validateCrossSite(sites: readonly ResolvedSite[]): void {
    const seenWorkers = new Map<string, string>();
    for (const site of sites) {
        const productionName = site.id;
        if (seenWorkers.has(productionName)) {
            throw new TenantConfigError(
                `Worker name "${productionName}" is used by both ` +
                    `"${seenWorkers.get(productionName)}" and "${site.id}"`,
            );
        }
        seenWorkers.set(productionName, site.id);

        const hostnames = new Set([site.hostname]);
        for (const other of sites) {
            if (other.id === site.id) continue;
            if (hostnames.has(other.hostname)) {
                throw new TenantConfigError(
                    `Sites "${site.id}" and "${other.id}" share hostname ` +
                        `${other.hostname}`,
                );
            }
        }
    }
}
