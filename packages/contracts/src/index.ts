/**
 * The module contract: what a module's `hearthlog.module.json` may declare.
 *
 * A manifest is plain data. The composer reads and validates it without
 * running any module code; entry points are paths inside the module package.
 * Runtime-neutral: no Svelte, no browser or Node globals.
 */

export const MODULE_API_VERSION = 1;

export type NavGroup = 'Money' | 'Life' | 'Tools';

export interface ModuleNavChild {
    id: string;
    label: string;
    href: string;
    /** Query value (`tab=…`) that selects this child, or null for the default. */
    tab?: string | null;
    /** Attention badge id (an `AttentionBadge.ids` entry) for work that lives on this sub-page. */
    badgeId?: string;
}

export interface ModuleShortcut {
    id: string;
    label: string;
    subtitle: string;
    keywords: string;
    query?: string;
    href?: string;
}

export interface ModuleFeature {
    /** Persisted in tenants.json; never rename. */
    id: string;
    path: string;
    label: string;
    subtitle: string;
    keywords: string;
    navGroup: NavGroup;
    /** An `mdi` icon name, for example `calculator-variant-outline`. */
    icon: string;
    mobilePrimary?: boolean;
    mobileOrder?: number;
    /** Place in the sidebar and menus: lower first; a feature without one comes last. */
    navOrder?: number;
    /** Sub-pages the sidebar lists under the section. */
    children?: ModuleNavChild[];
    shortcuts?: ModuleShortcut[];
}

export interface ModuleRoute {
    /** URL path, for example `/calc/dates` or `/finance/[year]/[month]` (SvelteKit parameters). */
    path: string;
    /** The page component, relative to the module root. */
    page: string;
    /** An optional module exporting `load`, relative to the module root. */
    load?: string;
    /** The page fits the screen from `lg` and scrolls inside itself. */
    fitsScreen?: boolean;
    /** The page stays mounted while only the route's parameters change (a month workbench). */
    keepMounted?: boolean;
    /**
     * This route immediately redirects to a page matching `resolvesTo` (Finance
     * `/finance` to the current month); that navigation is not timed twice.
     */
    resolvesTo?: string;
    /**
     * A page outside every feature path that needs some of the module's
     * features: at least `minimum` (default 1) of `features` must be enabled.
     */
    requires?: { features: string[]; minimum?: number };
}

/**
 * One navigation destination for several features of a module, such as
 * Health for Body, Nutrition, and Activity. It lands on the first visible
 * child and lists the visible children as sub-pages.
 */
export interface ModuleSection {
    id: string;
    label: string;
    keywords: string;
    navGroup: NavGroup;
    icon: string;
    mobilePrimary?: boolean;
    mobileOrder?: number;
    children: Array<{
        id: string;
        label: string;
        href: string;
        /** Shown when this feature is enabled; omit with `requiresRoute` for a combined page. */
        feature?: string;
        /** Shown when that route's `requires` holds, for example the Day view. */
        requiresRoute?: string;
        /** Left out of the section's subtitle (a library rather than a place). */
        secondary?: boolean;
    }>;
}

/** An old address that moves: `path` with every `query` value leads to `to` when `feature` is enabled. */
export interface ModuleRedirect {
    path: string;
    query?: Record<string, string>;
    to: string;
    feature: string;
}

export interface ModuleManifest {
    manifestVersion: 1;
    /** Publisher-qualified and stable, for example `org.stor.calc`. */
    id: string;
    /** The package name, for example `@hearthlog/module-calc`. */
    package: string;
    version: string;
    compatibility: { moduleApi: number };
    features: ModuleFeature[];
    routes: ModuleRoute[];
    /** Layouts wrapping every route beneath `path` (Finance's assets and screen fit). */
    layouts?: Array<{ path: string; page: string; load?: string }>;
    /** `mdi` icon names the module's calendar sources use (`presentation.icon`). */
    calendarIcons?: string[];
    section?: ModuleSection;
    redirects?: ModuleRedirect[];
    /** Tables the module owns are rebuilt from history when this changes. */
    projectionVersion?: number;
    /**
     * Entry points under `src/data/`: `definitions` exports ENTITY_DEFINITIONS
     * (the module's persisted entities), `repositories` exports
     * createRepositories(session) for `queryDatabase`.
     */
    data?: { definitions?: string; repositories?: string };
    /** `depends('app:…')` keys the module's loaders declare. */
    refreshKeys?: string[];
    /** AI decision capabilities the module implements (`ServerModule.ai`), by id. */
    aiCapabilities?: string[];
    /** Service integration kinds the module implements (`ServerModule.integrations`), each needing one of its features. */
    integrationKinds?: Array<{ kind: string; feature: string }>;
    /** Browser code the app runs at startup for tenants that enable the module (`export function start()`). */
    startup?: string;
    /** A browser file exporting `attention` (an `AttentionContribution`): navigation badges and figures, and native reminders. */
    attention?: string;
    /**
     * Functions native apps call over the engine bridge: `contract` (`defineNativeContract`, schemas only, loaded in
     * Node to write the Swift types) and `api` (`implementNativeApi`, run in the engine page), both in `src/native/`;
     * `swiftTypes` is where `hearthlog apple:types` writes the Swift for them.
     */
    native?: { contract: string; api: string; swiftTypes?: string };
    /** A stylesheet (`./src/styles.css`) with the module's recipes; the host imports it after the shell's, only for tenants that enable the module. */
    styles?: string;
    /** Browser databases the module keeps files in, listed in the storage statistics. */
    localStores?: Array<{ database: string; label: string; fileStore?: string; kinds?: boolean }>;
    server?: ModuleServer;
    /** The module's own anonymous Worker, deployed beside the gateway (Gallery's public pages). */
    publicWorker?: { directory: string; name: string };
}

/** A count on a navigation destination or sub-page, shown while work is late. */
export interface AttentionBadge {
    /** Navigation ids that carry the badge (a section and its sub-page). */
    ids: string[];
    count: number;
    tone: 'negative' | 'warning';
    label: string;
}

/**
 * One live figure beside a navigation destination or sub-page: spent today, steps, the next due date. It reads
 * at a glance in the muted ink, so the sidebar answers the quick check; a badge takes its place while work is late.
 */
export interface NavFigure {
    /** The navigation id it sits on: a destination's id or a sub-page's `NavChild.id`. */
    id: string;
    /** Already formatted and short, about 14 characters at most ("−1 284 Kč", "8 912 steps", "Tue 20"). */
    text: string;
    /** Read after the destination's name by screen readers and shown in the rail's tooltip ("1 284 Kč spent today"). */
    label: string;
}

/** A local notification the native shell schedules. */
export interface AttentionReminder {
    id: string;
    title: string;
    body: string;
    /** Local wall-clock time, `YYYY-MM-DDTHH:mm`; the device's time zone applies. */
    at: string;
    /** Route opened when the notification is tapped. */
    path: string;
}

/** What a module tells the app about late or upcoming work and its live figures; all read SQL through `queryDatabase`. */
export interface AttentionContribution {
    badges?(context: { today: string }): Promise<AttentionBadge[]>;
    /** At most one figure per navigation id; leave a figure out rather than show a zero. */
    figures?(context: { today: string }): Promise<NavFigure[]>;
    reminders?(context: { today: Date }): Promise<AttentionReminder[]>;
}

/**
 * What a module adds to the gateway Worker. The host keeps Access auth, the
 * Ledger proxy, the user session, and administration; a module owns only the
 * routes, jobs, and bindings it declares.
 */
export interface ModuleServer {
    /** A file in `src/server/` whose default export is a `ServerModule`. */
    entry: string;
    /** Path prefixes the module's handler serves; the host dispatches them. May be empty (a module that only adds jobs or integrations). */
    routes?: string[];
    /** The module runs a daily job (the gateway's `scheduled` handler). */
    scheduled?: boolean;
    bindings?: ModuleBinding[];
    /** Worker variables, each copied from the tenant's infrastructure or from the module's own settings; an `optional` one is left out when unset. */
    vars?: ModuleVariable[];
    /** Write-only Worker secrets supplied by the operator, never emitted into configuration or browser code. */
    secrets?: Array<{ name: string }>;
    /**
     * A file in `src/server/` whose default export is a `DevServerModule`. The Vite dev server hands it the
     * requests under `routes`; it is never bundled into a deployed gateway.
     */
    dev?: string;
}

/**
 * A Worker variable. `resource` names a key of the core's infrastructure; `setting` names a key of the
 * module's own block in the tenant's `moduleSettings`, which the core validates against `format`.
 */
export type ModuleVariable =
    | { name: string; resource: string; optional?: boolean }
    | { name: string; setting: string; format?: ModuleSettingFormat; values?: string[]; optional?: boolean };

/** How the core validates a module setting. `values`, when present, also limits it to those strings. */
export type ModuleSettingFormat = 'text' | 'https-origin' | 's3-bucket' | 's3-region';

export const MODULE_SETTING_FORMATS: readonly ModuleSettingFormat[] = ['text', 'https-origin', 's3-bucket', 's3-region'];

/** Why a module setting value is invalid, or null when it is valid. */
export function moduleSettingProblem(variable: { format?: ModuleSettingFormat; values?: readonly string[] }, value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return 'must be a non-empty string';
    if (variable.values && !variable.values.includes(value)) return `must be one of ${variable.values.map((option) => `"${option}"`).join(', ')}`;
    switch (variable.format ?? 'text') {
        case 'https-origin': {
            let url: URL | null = null;
            try { url = new URL(value); } catch { url = null; }
            return url && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? null : 'must be an HTTPS origin';
        }
        case 's3-bucket': return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) ? null : 'must be an S3 bucket name';
        case 's3-region': return /^[a-z0-9-]+$/.test(value) ? null : 'must be an S3 region';
        default: return null;
    }
}

/** A harmless value of the right shape, for builds that check a module without real configuration. */
export function moduleSettingPlaceholder(variable: { format?: ModuleSettingFormat; values?: readonly string[] }): string {
    if (variable.values?.length) return variable.values[0];
    return { 'https-origin': 'https://module-check.example.invalid', 's3-bucket': 'module-check', 's3-region': 'us-east-1', text: 'module-check' }[variable.format ?? 'text'];
}

/** What the Vite dev server gives a module's `dev` entry for one request. Never available in a deployed build. */
export interface DevServerContext {
    /** The local Ledger binding and its token, shaped like the gateway's `LEDGER` and `LEDGER_AUTH_TOKEN`. */
    env: { LEDGER: { fetch(request: Request): Promise<Response> }; LEDGER_AUTH_TOKEN: string };
    /** The local developer, standing in for the Access identity a deployed gateway verifies. */
    identity: { email: string };
}

/** What a module's `dev` entry exports. */
export interface DevServerModule {
    handle(request: Request, context: DevServerContext): Promise<Response>;
}

/** A module-owned binding; bucket resource names come from the tenant's infrastructure. */
export type ModuleBinding =
    | { binding: string; type: 'r2'; resource: string }
    | { binding: string; type: 'images' }
    /** A SQLite Durable Object exported by the module's server entry. Names are persistent deployment identities. */
    | { binding: string; type: 'durable-object'; className: string };

/** What a module's server entry exports. `TEnv` is the Worker's `Env`. */
export interface ServerModule<TEnv = unknown> {
    id: string;
    routes: Array<{ prefix: string; handle(request: Request, env: TEnv): Promise<Response> }>;
    scheduled?(env: TEnv): Promise<unknown>;
    /** AI decision capabilities the manifest declares (`aiCapabilities`), by id. */
    ai?: Record<string, AiCapabilityDefinition>;
    /** Handlers for the integration kinds the manifest declares (`integrationKinds`), by kind. */
    integrations?: Record<string, IntegrationHandler<TEnv>>;
    /** Files a fork carries into its child log; omit when the module's files are shared by the whole app. */
    forkFiles?: FileContributor;
}

/** One option a decision model may pick, in words the model reads. */
export interface AiDecisionOption {
    value: string;
    meaning: string;
}

/** A request the browser sent that is not valid; the host answers 400 with this message. */
export class AiRequestError extends Error {}

/** What the host needs from a module to run one AI decision capability. The browser sends data; the module builds the question and owns the options. */
export interface AiCapabilityDefinition {
    /** The options the model may pick from; code owns them, so a model can never invent one. */
    options(): AiDecisionOption[];
    /** Validates one item the browser sent; throws `AiRequestError`. */
    parseItem(value: unknown): { id: string };
    /** The question for one parsed item. */
    question(item: { id: string }): { state: string; instructions: string };
}

/** Field readers for `parseItem`: each throws `AiRequestError` with a fixed message. */
export const aiInput = {
    object(value: unknown): Record<string, unknown> {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AiRequestError('Invalid item');
        return value as Record<string, unknown>;
    },
    id(value: unknown): string {
        if (typeof value !== 'string' || value.length === 0 || value.length > 64) throw new AiRequestError('Invalid item id');
        return value;
    },
    text(value: unknown, max: number, allowEmpty = false): string {
        if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.trim() === '')) throw new AiRequestError('Invalid text');
        return value.trim();
    },
};

/** One event a service integration appends. */
export interface ServiceEvent {
    id: string;
    type: string;
    entityId: string;
    timestamp: number;
    baseEntityVersion?: number;
    payload: Record<string, unknown>;
}

export interface ServiceAppend {
    requestId: string;
    events: ServiceEvent[];
}

/** What the host hands an integration handler after it has verified the service token and rate limit. */
export interface IntegrationRequest<TEnv = unknown> {
    env: TEnv;
    /** The configured integration the token belongs to; its events are authored `service:<id>`. */
    integration: { id: string; logId: string };
    /** The last path segment of the request (for steps, the date). */
    segment: string;
    /** The parsed JSON body (at most 1 KiB). */
    body: unknown;
    now: number;
    /**
     * Create or update one entity as the service identity. `build` receives the
     * entity's version to continue from (undefined when creating); the host
     * retries on conflicts. A handler never gets a generic append.
     */
    upsertEntity(build: (base: number | undefined) => Promise<ServiceAppend>): Promise<'created' | 'updated'>;
}

/** Returns the JSON the host sends back; throws `IntegrationRequestError` for a bad request. */
export type IntegrationHandler<TEnv = unknown> = (request: IntegrationRequest<TEnv>) => Promise<unknown>;

/** A fork event as file contributors see it: the stored event, with its log version. */
export interface ForkHistoryEvent {
    type: string;
    payload: Record<string, unknown>;
}

/** One object a fork must carry into its child log, in a bucket binding of the gateway. */
export interface ForkFile {
    /** The gateway's R2 binding name, for example `INVOICE_PDFS`. */
    bucket: string;
    sourceKey: string;
    childKey: string;
    /** The fork cannot finish while a required file is missing. */
    required: boolean;
}

/** Decides which files a fork copies from the events it inherits. Pure. */
export type FileContributor = (
    events: readonly ForkHistoryEvent[],
    scope: { appId: string; sourceLogId: string; childLogId: string },
) => ForkFile[];

export class ManifestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ManifestError';
    }
}

const MODULE_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;
const FEATURE_ID = /^[a-z][a-z0-9-]*$/;
const ROUTE_PATH = /^\/[a-z0-9-]+(\/([a-z0-9-]+|\[[a-z][a-zA-Z0-9]*\]))*$/;
const ENTRY = /^\.\/[A-Za-z0-9_./-]+\.(svelte|ts)$/;
const ICON = /^[a-z0-9-]+$/;
const REFRESH_KEY = /^app:[a-z0-9-]+$/;

function fail(label: string, problem: string): never {
    throw new ManifestError(`${label}: ${problem}`);
}

function keys(label: string, value: unknown, known: readonly string[]): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(label, 'must be an object');
    for (const key of Object.keys(value)) {
        if (!known.includes(key)) fail(label, `unknown key "${key}"`);
    }
    return value as Record<string, unknown>;
}

function text(label: string, value: unknown, pattern?: RegExp): string {
    if (typeof value !== 'string' || !value.trim()) fail(label, 'must be a non-empty string');
    if (pattern && !pattern.test(value)) fail(label, `"${value}" is not allowed`);
    return value;
}

function entry(label: string, value: unknown): string {
    const path = text(label, value, ENTRY);
    if (path.split('/').includes('..')) fail(label, 'must stay inside the module');
    return path;
}

/** Validate one manifest; returns it typed. Throws ManifestError on the first problem. */
export function validateManifest(value: unknown, source = 'hearthlog.module.json'): ModuleManifest {
    const manifest = keys(source, value, ['$schema', 'manifestVersion', 'id', 'package', 'version', 'compatibility', 'features', 'routes', 'layouts', 'calendarIcons', 'section', 'redirects', 'data', 'projectionVersion', 'startup', 'attention', 'native', 'styles', 'localStores', 'aiCapabilities', 'integrationKinds', 'server', 'publicWorker', 'refreshKeys']);
    if (manifest.manifestVersion !== 1) fail(source, 'manifestVersion must be 1');
    const id = text(`${source} id`, manifest.id, MODULE_ID);
    text(`${source} package`, manifest.package, /^@[a-z0-9-]+\/[a-z0-9-]+$/);
    text(`${source} version`, manifest.version, /^\d+\.\d+\.\d+$/);
    const compatibility = keys(`${id} compatibility`, manifest.compatibility, ['moduleApi']);
    if (compatibility.moduleApi !== MODULE_API_VERSION) fail(id, `needs module API ${String(compatibility.moduleApi)}, this platform provides ${MODULE_API_VERSION}`);

    if (!Array.isArray(manifest.features)) fail(id, 'features must be an array');
    const featureIds = (manifest.features as Array<{ id?: unknown }>).map((feature) => String(feature.id));
    for (const [index, raw] of manifest.features.entries()) {
        const label = `${id} features[${index}]`;
        const feature = keys(label, raw, ['id', 'path', 'label', 'subtitle', 'keywords', 'navGroup', 'icon', 'mobilePrimary', 'mobileOrder', 'navOrder', 'children', 'shortcuts']);
        text(`${label} id`, feature.id, FEATURE_ID);
        text(`${label} path`, feature.path, ROUTE_PATH);
        for (const key of ['label', 'subtitle', 'keywords'] as const) text(`${label} ${key}`, feature[key]);
        if (!['Money', 'Life', 'Tools'].includes(feature.navGroup as string)) fail(label, 'navGroup must be Money, Life, or Tools');
        text(`${label} icon`, feature.icon, ICON);
        if (feature.navOrder !== undefined && !Number.isInteger(feature.navOrder)) fail(label, 'navOrder must be an integer');
        for (const [childIndex, child] of ((feature.children ?? []) as unknown[]).entries()) {
            const childLabel = `${label} children[${childIndex}]`;
            const value = keys(childLabel, child, ['id', 'label', 'href', 'tab', 'badgeId']);
            text(`${childLabel} id`, value.id, FEATURE_ID);
            text(`${childLabel} label`, value.label);
            text(`${childLabel} href`, value.href, /^\/[^\s]*$/);
        }
        for (const [shortcutIndex, shortcut] of ((feature.shortcuts ?? []) as unknown[]).entries()) {
            const shortcutLabel = `${label} shortcuts[${shortcutIndex}]`;
            const value = keys(shortcutLabel, shortcut, ['id', 'label', 'subtitle', 'keywords', 'query', 'href']);
            for (const key of ['id', 'label', 'subtitle', 'keywords'] as const) text(`${shortcutLabel} ${key}`, value[key]);
        }
    }

    if (!Array.isArray(manifest.routes)) fail(id, 'routes must be an array');
    for (const [index, raw] of manifest.routes.entries()) {
        const label = `${id} routes[${index}]`;
        const route = keys(label, raw, ['path', 'page', 'load', 'fitsScreen', 'keepMounted', 'resolvesTo', 'requires']);
        if (route.resolvesTo !== undefined) text(`${label} resolvesTo`, route.resolvesTo, ROUTE_PATH);
        text(`${label} path`, route.path, ROUTE_PATH);
        entry(`${label} page`, route.page);
        if (route.load !== undefined) entry(`${label} load`, route.load);
        if (route.requires !== undefined) {
            const requires = keys(`${label} requires`, route.requires, ['features', 'minimum']);
            if (!Array.isArray(requires.features) || requires.features.length === 0) fail(label, 'requires.features must list features');
            for (const feature of requires.features) {
                if (!featureIds.includes(feature as string)) fail(label, `requires an unknown feature "${String(feature)}"`);
            }
        }
    }
    for (const [index, raw] of ((manifest.layouts ?? []) as unknown[]).entries()) {
        const label = `${id} layouts[${index}]`;
        const layout = keys(label, raw, ['path', 'page', 'load']);
        text(`${label} path`, layout.path, ROUTE_PATH);
        entry(`${label} page`, layout.page);
        if (layout.load !== undefined) entry(`${label} load`, layout.load);
    }
    for (const icon of (manifest.calendarIcons ?? []) as unknown[]) text(`${id} calendarIcons`, icon, ICON);
    if (manifest.section !== undefined) {
        const label = `${id} section`;
        const section = keys(label, manifest.section, ['id', 'label', 'keywords', 'navGroup', 'icon', 'mobilePrimary', 'mobileOrder', 'children']);
        text(`${label} id`, section.id, FEATURE_ID);
        text(`${label} label`, section.label);
        text(`${label} icon`, section.icon, ICON);
        if (!['Money', 'Life', 'Tools'].includes(section.navGroup as string)) fail(label, 'navGroup must be Money, Life, or Tools');
        if (!Array.isArray(section.children) || section.children.length === 0) fail(label, 'children must not be empty');
        for (const [index, raw] of section.children.entries()) {
            const child = keys(`${label} children[${index}]`, raw, ['id', 'label', 'href', 'feature', 'requiresRoute', 'secondary']);
            text(`${label} children[${index}] href`, child.href, ROUTE_PATH);
            if ((child.feature === undefined) === (child.requiresRoute === undefined)) fail(label, 'each child names a feature or a requiring route');
            if (child.feature !== undefined && !featureIds.includes(child.feature as string)) fail(label, `unknown feature "${String(child.feature)}"`);
        }
    }
    for (const [index, raw] of ((manifest.redirects ?? []) as unknown[]).entries()) {
        const redirect = keys(`${id} redirects[${index}]`, raw, ['path', 'query', 'to', 'feature']);
        text(`${id} redirects[${index}] path`, redirect.path, ROUTE_PATH);
        text(`${id} redirects[${index}] to`, redirect.to, ROUTE_PATH);
        if (!featureIds.includes(redirect.feature as string)) fail(id, `redirect needs an unknown feature "${String(redirect.feature)}"`);
    }
    if (manifest.data !== undefined) {
        const data = keys(`${id} data`, manifest.data, ['definitions', 'repositories']);
        for (const key of ['definitions', 'repositories'] as const) {
            if (data[key] !== undefined && !/^\.\/src\/data\/[a-z0-9-]+\.ts$/.test(entry(`${id} data.${key}`, data[key]))) {
                fail(id, `data.${key} must be a file in src/data/`);
            }
        }
    }
    for (const key of (manifest.refreshKeys ?? []) as unknown[]) text(`${id} refreshKeys`, key, REFRESH_KEY);
    if (manifest.projectionVersion !== undefined && (!Number.isInteger(manifest.projectionVersion) || (manifest.projectionVersion as number) < 1)) {
        fail(id, 'projectionVersion must be a positive integer');
    }
    if (manifest.startup !== undefined) entry(`${id} startup`, manifest.startup);
    if (manifest.attention !== undefined) entry(`${id} attention`, manifest.attention);
    if (manifest.native !== undefined) {
        const native = keys(`${id} native`, manifest.native, ['contract', 'api', 'swiftTypes']);
        for (const key of ['contract', 'api'] as const) {
            if (!/^\.\/src\/native\/[a-z0-9-]+\.ts$/.test(entry(`${id} native.${key}`, native[key]))) fail(id, `native.${key} must be a file in src/native/`);
        }
        if (native.swiftTypes !== undefined && text(`${id} native.swiftTypes`, native.swiftTypes, /^\.\/[A-Za-z0-9_./-]+\.swift$/).split('/').includes('..')) {
            fail(id, 'native.swiftTypes must stay inside the module');
        }
    }
    if (manifest.styles !== undefined) text(`${id} styles`, manifest.styles, /^\.\/src\/[a-z0-9-]+\.css$/);
    for (const [index, raw] of ((manifest.localStores ?? []) as unknown[]).entries()) {
        const store = keys(`${id} localStores[${index}]`, raw, ['database', 'label', 'fileStore', 'kinds']);
        text(`${id} localStores[${index}] database`, store.database, /^[a-z][a-z0-9-]*$/);
        text(`${id} localStores[${index}] label`, store.label);
    }
    for (const capability of (manifest.aiCapabilities ?? []) as unknown[]) text(`${id} aiCapabilities`, capability, /^[a-z][a-z0-9-]*$/);
    for (const [index, raw] of ((manifest.integrationKinds ?? []) as unknown[]).entries()) {
        const kind = keys(`${id} integrationKinds[${index}]`, raw, ['kind', 'feature']);
        text(`${id} integrationKinds[${index}] kind`, kind.kind, /^[a-z][a-z0-9-]*$/);
        if (!featureIds.includes(kind.feature as string)) fail(id, `integration kind "${String(kind.kind)}" needs an unknown feature`);
    }
    if (manifest.server !== undefined) {
        const label = `${id} server`;
        const server = keys(label, manifest.server, ['entry', 'routes', 'scheduled', 'bindings', 'vars', 'secrets', 'dev']);
        if (!/^\.\/src\/server\/[A-Za-z0-9_-]+\.ts$/.test(entry(`${label} entry`, server.entry))) fail(label, 'entry must be a file in src/server/');
        if (server.dev !== undefined) {
            if (!/^\.\/src\/server\/[A-Za-z0-9_-]+\.ts$/.test(entry(`${label} dev`, server.dev))) fail(label, 'dev must be a file in src/server/');
            if (server.dev === server.entry) fail(label, 'dev must not be the gateway entry');
            if (!(server.routes as unknown[] | undefined)?.length) fail(label, 'dev needs routes to serve');
        }
        for (const prefix of (server.routes ?? []) as unknown[]) text(`${label} routes`, prefix, /^\/api\/[a-z0-9-]+(\/[a-z0-9-]+)*$/);
        const objectClasses = new Set<string>();
        for (const [index, raw] of ((server.bindings ?? []) as unknown[]).entries()) {
            const binding = keys(`${label} bindings[${index}]`, raw, ['binding', 'type', 'resource', 'className']);
            text(`${label} bindings[${index}] binding`, binding.binding, /^[A-Z][A-Z0-9_]*$/);
            if (binding.type === 'durable-object') {
                text(`${label} bindings[${index}] className`, binding.className, /^[A-Z][A-Za-z0-9]*$/);
                if (objectClasses.has(binding.className as string)) fail(label, 'a Durable Object class is declared twice');
                objectClasses.add(binding.className as string);
                if (binding.resource !== undefined) fail(label, 'Durable Objects do not use an infrastructure resource');
            } else if (binding.className !== undefined) fail(label, 'className belongs to a Durable Object');
            else if (binding.type === 'r2') text(`${label} bindings[${index}] resource`, binding.resource, /^[a-zA-Z]+$/);
            else if (binding.type !== 'images' || binding.resource !== undefined) fail(label, `bindings[${index}] must be an r2 bucket (with a resource) or images`);
        }
        const settings = new Set<string>();
        for (const [index, raw] of ((server.vars ?? []) as unknown[]).entries()) {
            const at = `${label} vars[${index}]`;
            const variable = keys(at, raw, ['name', 'resource', 'setting', 'format', 'values', 'optional']);
            text(`${at} name`, variable.name, /^[A-Z][A-Z0-9_]*$/);
            if (variable.optional !== undefined && typeof variable.optional !== 'boolean') fail(at, 'optional must be a boolean');
            if ((variable.resource === undefined) === (variable.setting === undefined)) fail(at, 'needs either a resource or a setting');
            if (variable.resource !== undefined) {
                text(`${at} resource`, variable.resource, /^[a-zA-Z]+$/);
                if (variable.format !== undefined || variable.values !== undefined) fail(at, 'format and values belong to a setting');
                continue;
            }
            const setting = text(`${at} setting`, variable.setting, /^[a-z][a-zA-Z0-9]*$/);
            if (settings.has(setting)) fail(at, `setting "${setting}" is declared twice`);
            settings.add(setting);
            if (variable.format !== undefined && !MODULE_SETTING_FORMATS.includes(variable.format as ModuleSettingFormat)) fail(at, `format must be one of ${MODULE_SETTING_FORMATS.join(', ')}`);
            if (variable.values !== undefined) {
                if (!Array.isArray(variable.values) || !variable.values.length) fail(at, 'values must be a non-empty array');
                for (const option of variable.values) text(`${at} values`, option);
            }
        }
        if (server.secrets !== undefined && !Array.isArray(server.secrets)) fail(label, 'secrets must be an array');
        const names = new Set<string>([
            ...((server.bindings ?? []) as Array<{ binding: string }>).map(binding => binding.binding),
            ...((server.vars ?? []) as Array<{ name: string }>).map(variable => variable.name),
        ]);
        for (const [index, raw] of ((server.secrets ?? []) as unknown[]).entries()) {
            const secret = keys(`${label} secrets[${index}]`, raw, ['name']);
            const name = text(`${label} secrets[${index}] name`, secret.name, /^[A-Z][A-Z0-9_]*$/);
            if (names.has(name) || /^(?:LEDGER(?:_|$)|CF_ACCESS_|STOR_|INVOICE_|AI(?:_|$)|CALENDAR_|ASSETS$|INTEGRATIONS$)/.test(name)) {
                fail(label, `secret ${name} collides with an existing or reserved Worker binding`);
            }
            names.add(name);
        }
    }
    if (manifest.publicWorker !== undefined) {
        const worker = keys(`${id} publicWorker`, manifest.publicWorker, ['directory', 'name']);
        text(`${id} publicWorker directory`, worker.directory, /^\.\/[a-z0-9-]+$/);
        text(`${id} publicWorker name`, worker.name, FEATURE_ID);
    }
    return value as ModuleManifest;
}

export interface ReservedNames {
    featureIds: readonly string[];
    routePaths: readonly string[];
    refreshKeys: readonly string[];
    /** API prefixes the gateway host serves itself. */
    apiPrefixes?: readonly string[];
}

/**
 * Reject two modules (or a module and the core) claiming the same feature,
 * route, or refresh key. Nothing is resolved by registration order.
 */
export function findCollisions(manifests: readonly ModuleManifest[], reserved: ReservedNames): string[] {
    const problems: string[] = [];
    const owners = new Map<string, string>();
    const claim = (kind: string, name: string, owner: string) => {
        const key = `${kind}:${name}`;
        const existing = owners.get(key);
        if (existing && existing !== owner) problems.push(`${kind} "${name}" is claimed by ${existing} and ${owner}`);
        else owners.set(key, owner);
    };
    for (const id of reserved.featureIds) claim('feature', id, 'the core');
    for (const path of reserved.routePaths) claim('route', path, 'the core');
    for (const key of reserved.refreshKeys) claim('refresh key', key, 'the core');
    for (const name of ['CalendarFeedRenderer', 'default', 'proxyAccessSession', 'proxyLedgerAdminRequest', 'proxyLedgerRequest', 'serveAssetOrAppShell']) claim('Worker export', name, 'the core');
    for (const manifest of manifests) {
        claim('module', manifest.id, manifest.package);
        for (const feature of manifest.features) claim('feature', feature.id, manifest.id);
        for (const route of manifest.routes) claim('route', route.path, manifest.id);
        for (const key of manifest.refreshKeys ?? []) claim('refresh key', key, manifest.id);
        for (const binding of manifest.server?.bindings ?? []) {
            claim('binding', binding.binding, manifest.id);
            if (binding.type === 'durable-object') claim('Worker export', binding.className, manifest.id);
        }
        for (const variable of manifest.server?.vars ?? []) claim('binding', variable.name, manifest.id);
        for (const secret of manifest.server?.secrets ?? []) claim('binding', secret.name, manifest.id);
    }
    // API prefixes collide when one is the other or lies beneath it.
    const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    const taken: Array<{ prefix: string; owner: string }> = (reserved.apiPrefixes ?? []).map((prefix) => ({ prefix, owner: 'the core' }));
    for (const manifest of manifests) {
        for (const prefix of manifest.server?.routes ?? []) {
            const other = taken.find((entry) => entry.owner !== manifest.id && overlaps(entry.prefix, prefix));
            if (other) problems.push(`API prefix "${prefix}" of ${manifest.id} overlaps "${other.prefix}" of ${other.owner}`);
            taken.push({ prefix, owner: manifest.id });
        }
    }
    return problems;
}
