import { listUnsyncedOperations } from './outbox.js';
import { isLedgerServiceError } from '../ledger/errors.js';
import { movedWorkspace } from './moved.svelte.js';
import { getLedgerClient, preparePendingOperations, sync } from './sync.svelte.js';
import {
    buildPendingWorkFile,
    classifyImportFailure,
    summarizeImport,
    type ImportReport,
    type ImportResult,
    type PendingWorkFile,
} from './pending-work.js';

/** This device's unsynced requests as a file, to import at the workspace's new home. */
export async function exportPendingWork(origin = location.origin): Promise<{ file: PendingWorkFile; name: string }> {
    await preparePendingOperations().catch(() => undefined);
    const operations = await listUnsyncedOperations();
    const file = buildPendingWorkFile({ origin, destination: movedWorkspace.value?.destination ?? null, operations });
    return { file, name: `pending-work-${new URL(origin).hostname}-${file.exportedAt.slice(0, 10)}.json` };
}

/**
 * Sends the requests of an exported file to this origin's Ledger, in order, as
 * they were queued. A request the Ledger already accepted is recognized by its
 * ID and counts as applied; one that clashes with newer work is reported, not
 * forced. An answer that means "not now" stops the run so it can be repeated.
 */
export async function importPendingWork(file: PendingWorkFile): Promise<ImportReport> {
    const client = getLedgerClient();
    const results: ImportResult[] = [];
    for (const operation of file.operations) {
        const requestId = operation.request.requestId;
        const unavailable = results.some((result) => result.outcome === 'unavailable');
        if (unavailable) {
            results.push({ requestId, outcome: 'unavailable', message: 'Not tried: an earlier request could not be sent. Import the file again later.' });
            continue;
        }
        try {
            await client.appendEvents(operation.logId, operation.request);
            results.push({ requestId, outcome: 'applied', message: 'Applied' });
        } catch (error) {
            const status = isLedgerServiceError(error) ? error.statusCode : undefined;
            const code = isLedgerServiceError(error) ? error.code : undefined;
            results.push({ requestId, outcome: classifyImportFailure(status, code), message: error instanceof Error ? error.message : String(error) });
        }
    }
    await sync('manual').catch(() => undefined);
    return summarizeImport(results);
}
