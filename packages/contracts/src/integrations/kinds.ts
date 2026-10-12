/**
 * Service integrations: named non-browser sources (an iPhone Shortcut, for
 * example) that append events to one Ledger log through the frontend Worker.
 *
 * Shared by the Worker and the tenant scripts, so it stays free of Svelte,
 * `$app` and Worker globals. Each kind is a narrow typed write; a kind never
 * exposes a generic append.
 */

import type { FeatureId } from '../features/registry.js';
import { MODULE_INTEGRATION_KINDS, type ModuleIntegrationKind } from '#generated/modules';

/** The kinds the modules implement (`integrationKinds` in their manifests). */
export const INTEGRATION_KINDS: readonly ModuleIntegrationKind[] = MODULE_INTEGRATION_KINDS.map((entry) => entry.kind);
export type IntegrationKind = ModuleIntegrationKind;

/** The feature a site must enable before it can run a kind. */
export const INTEGRATION_KIND_FEATURE = Object.fromEntries(
    MODULE_INTEGRATION_KINDS.map((entry) => [entry.kind, entry.feature]),
) as Record<IntegrationKind, FeatureId>;

export const INTEGRATION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cloudflare Access service-token client ids look like `<32 hex>.access`. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export interface IntegrationDefinition {
    /** Stable id. It becomes the URL segment and the event actor `service:<id>`. */
    id: string;
    kind: IntegrationKind;
    /** The one Ledger log this integration writes to. */
    logId: string;
    /**
     * The Access service token's client id (its JWT `common_name`). Absent until
     * the token exists; an integration without one is configured but inactive.
     */
    clientId?: string;
}

/** The non-secret shape the Worker receives in its INTEGRATIONS variable. */
export type ActiveIntegration = Required<IntegrationDefinition>;

export function isIntegrationKind(value: unknown): value is IntegrationKind {
    return typeof value === 'string' && (INTEGRATION_KINDS as readonly string[]).includes(value);
}

export function isIntegrationId(value: unknown): value is string {
    return typeof value === 'string' && INTEGRATION_ID_PATTERN.test(value);
}

export function isIntegrationClientId(value: unknown): value is string {
    return typeof value === 'string' && CLIENT_ID_PATTERN.test(value);
}

export function isLogId(value: unknown): value is string {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Integrations that have a client id; the only ones the Worker accepts. */
export function activeIntegrations(integrations: readonly IntegrationDefinition[]): ActiveIntegration[] {
    return integrations.flatMap((integration) =>
        integration.clientId ? [{ ...integration, clientId: integration.clientId }] : [],
    );
}

/** Parse the Worker's INTEGRATIONS variable. Anything malformed yields no integrations. */
export function parseActiveIntegrations(value: string | undefined): ActiveIntegration[] {
    if (!value) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): ActiveIntegration[] => {
        if (entry === null || typeof entry !== 'object') return [];
        const { id, kind, logId, clientId } = entry as Record<string, unknown>;
        if (!isIntegrationId(id) || !isIntegrationKind(kind) || !isLogId(logId) || !isIntegrationClientId(clientId)) {
            return [];
        }
        return [{ id, kind, logId: logId.toLowerCase(), clientId }];
    });
}

/** The name of the Access service token that belongs to one integration of one site. */
export function integrationTokenName(siteId: string, integrationId: string): string {
    return `${siteId}/${integrationId}`;
}
