/**
 * The Ledger Worker's config. The Ledger is the same code for every stack; only its Worker name (and, for a site in
 * its own account, the account) differs. The Durable Object classes and their SQLite storage are tied to deployed data
 * and are never renamed.
 */

import type { InfrastructureDefinition } from "./tenant-config.js";
import { WRANGLER_BASE } from "./wrangler-base.js";

export const LEDGER_BASE = {
    main: "./index.ts",
    compatibility_flags: ["nodejs_compat"],
    preview_urls: false,
    durable_objects: {
        bindings: [
            { name: "LEDGER_APP", class_name: "LedgerApp" },
            { name: "APP_REGISTRY", class_name: "AppRegistry" },
        ],
    },
    exports: {
        LedgerApp: { type: "durable-object", storage: "sqlite" },
        AppRegistry: { type: "durable-object", storage: "sqlite" },
    },
    vars: {
        TOKEN_SIGNING_KEY_ID: "v1",
        TOKEN_SIGNING_PREVIOUS_KEY_ID: "",
        ALLOWED_ORIGINS: "",
        // "report" logs payloads that "enforce" would reject with 422; flip to "enforce" once the logs show only
        // intended rejections.
        EVENT_VALIDATION: "report",
    },
    observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 1 },
        traces: { enabled: true, head_sampling_rate: 0.05 },
    },
} as const;

/** The Ledger Worker of a stack: its name from the infrastructure, and the account when the site pins one. */
export function buildLedgerConfig(
    infrastructure: Pick<InfrastructureDefinition, "ledgerWorker">,
    accountId?: string,
): Record<string, unknown> {
    return {
        name: infrastructure.ledgerWorker,
        main: LEDGER_BASE.main,
        compatibility_date: WRANGLER_BASE.compatibility_date,
        compatibility_flags: LEDGER_BASE.compatibility_flags,
        preview_urls: LEDGER_BASE.preview_urls,
        durable_objects: LEDGER_BASE.durable_objects,
        exports: LEDGER_BASE.exports,
        vars: LEDGER_BASE.vars,
        observability: LEDGER_BASE.observability,
        // Pinning the account makes Wrangler refuse to deploy into any other one.
        ...(accountId ? { account_id: accountId } : {}),
    };
}
