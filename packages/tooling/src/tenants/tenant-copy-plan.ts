/**
 * What a tenant copy moves between buckets, as pure data.
 *
 * A copy gives the new tenant new app and log IDs, and private object keys
 * embed them: invoice files are `<prefix>/<appId>/<logId>/…` and Gallery
 * files `v1/<appId>/…`. Gallery publications are keyed by their own ID, but
 * their `owner.json` names the app and log. The generated-invoice cache
 * (`v1/<appId>/<logId>/invoices/…`) is not copied: it rebuilds on demand.
 * Calendar feeds are not copied: the new tenant creates its own.
 *
 * A **move** (the split of a shared tenant onto its own stack) keeps the app
 * and log IDs, so every key stays exactly as it is: `identity: true` copies
 * each prefix to the same name in the destination bucket, per app rather than
 * per log, and publication owner records are already correct and left alone.
 */

export interface TenantCopyMapping {
    sourceAppId: string;
    targetAppId: string;
    /** Source log ID to target log ID, for every copied log. Empty for an identity move. */
    logs: Readonly<Record<string, string>>;
    /** The destination keeps the app and log IDs, so keys are copied unchanged. */
    identity?: true;
}

/** The mapping of a move that keeps every identity. */
export function identityMapping(appId: string): TenantCopyMapping {
    return { sourceAppId: appId, targetAppId: appId, logs: {}, identity: true };
}

export type BucketPair = "invoice-pdfs" | "gallery-files" | "gallery-public";

export interface CopyJob {
    pair: BucketPair;
    fromPrefix: string;
    toPrefix: string;
    /** Rewrite `owner.json` objects under this prefix to the target app and log. */
    rewriteOwner?: boolean;
}

const INVOICE_FILE_PREFIXES = ["received/v1", "received-isdoc/v1", "issued/v1", "issued-isdoc/v1"] as const;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireId(value: string, label: string): void {
    if (!ID.test(value)) throw new Error(`${label} is not a UUID: ${value}`);
}

export function validateMapping(mapping: TenantCopyMapping): void {
    requireId(mapping.sourceAppId, "source app");
    requireId(mapping.targetAppId, "target app");
    if (mapping.identity) {
        if (mapping.sourceAppId !== mapping.targetAppId) throw new Error("an identity move keeps the app: source and target must be the same id");
        if (Object.keys(mapping.logs).length) throw new Error("an identity move names no logs: every log keeps its id");
        return;
    }
    if (mapping.sourceAppId === mapping.targetAppId) throw new Error("source and target apps are the same");
    for (const [source, target] of Object.entries(mapping.logs)) {
        requireId(source, "source log");
        requireId(target, "target log");
    }
}

/** Every prefix to copy, given the publications the source app owns. */
export function planFileCopies(mapping: TenantCopyMapping, ownedPublications: readonly string[]): CopyJob[] {
    validateMapping(mapping);
    const jobs: CopyJob[] = [];
    if (mapping.identity) {
        for (const prefix of INVOICE_FILE_PREFIXES) {
            const key = `${prefix}/${mapping.sourceAppId}/`;
            jobs.push({ pair: "invoice-pdfs", fromPrefix: key, toPrefix: key });
        }
        jobs.push({ pair: "gallery-files", fromPrefix: `v1/${mapping.sourceAppId}/`, toPrefix: `v1/${mapping.sourceAppId}/` });
        for (const publication of ownedPublications) {
            requireId(publication, "publication");
            const control = `v1/publications/${publication}/`;
            jobs.push({ pair: "gallery-files", fromPrefix: control, toPrefix: control });
            jobs.push({ pair: "gallery-public", fromPrefix: `v1/galleries/${publication}/`, toPrefix: `v1/galleries/${publication}/` });
        }
        return jobs;
    }
    for (const prefix of INVOICE_FILE_PREFIXES) {
        for (const [sourceLog, targetLog] of Object.entries(mapping.logs)) {
            jobs.push({
                pair: "invoice-pdfs",
                fromPrefix: `${prefix}/${mapping.sourceAppId}/${sourceLog}/`,
                toPrefix: `${prefix}/${mapping.targetAppId}/${targetLog}/`,
            });
        }
    }
    jobs.push({ pair: "gallery-files", fromPrefix: `v1/${mapping.sourceAppId}/`, toPrefix: `v1/${mapping.targetAppId}/` });
    for (const publication of ownedPublications) {
        requireId(publication, "publication");
        jobs.push({
            pair: "gallery-files",
            fromPrefix: `v1/publications/${publication}/`,
            toPrefix: `v1/publications/${publication}/`,
            rewriteOwner: true,
        });
        jobs.push({ pair: "gallery-public", fromPrefix: `v1/galleries/${publication}/`, toPrefix: `v1/galleries/${publication}/` });
    }
    return jobs;
}

export function isOwnerRecord(key: string): boolean {
    return /^v1\/publications\/[^/]+\/owner\.json$/.test(key);
}

/** The owner record for the target tenant; throws for a log the copy left out. */
export function rewriteOwner(record: unknown, mapping: TenantCopyMapping): { appId: string; logId: string } {
    const owner = record as { appId?: unknown; logId?: unknown } | null;
    if (!owner || typeof owner.appId !== "string" || typeof owner.logId !== "string") {
        throw new Error("publication owner record is malformed");
    }
    if (owner.appId !== mapping.sourceAppId) throw new Error("publication belongs to another app");
    const logId = mapping.logs[owner.logId];
    if (!logId) throw new Error(`publication belongs to log ${owner.logId}, which was not copied`);
    return { appId: mapping.targetAppId, logId };
}
