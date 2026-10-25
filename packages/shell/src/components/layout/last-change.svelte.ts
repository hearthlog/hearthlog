import { executeLocalCommand, onLocalCommandCommitted } from '@hearthlog/runtime/commands/index.js';
import { undoEvents, undoTargets, type UndoTarget } from '@hearthlog/runtime/commands/undo.js';
import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
import type { ExtendedAppEvent } from '@hearthlog/runtime/event/types.js';
import { refreshPageData } from '@hearthlog/runtime/runtime/refresh.js';
import { SYNC_INVALIDATION_TARGETS } from '@hearthlog/runtime/store/sync-invalidation.js';

const LIFETIME_MS = 10 * 60_000;

export interface LastChange {
    batchId: string;
    /** As Log history names the action ("Added Albert Vinohrady"). */
    label: string;
    /** The records whose removal reverses it, when it only added standard records; null otherwise. */
    reversal: UndoTarget[] | null;
    state: 'saved' | 'undoing' | 'undone' | 'failed';
}

async function actionLabel(eventIds: readonly string[]): Promise<string> {
    try {
        const [latest] = await queryDatabase((repositories) => repositories.history.list({ limit: 1, eventIds }));
        if (latest?.kind === 'action' && eventIds.includes(latest.id)) return latest.label;
    } catch {
        // The label is a courtesy; the change itself is saved.
    }
    return 'Saved your change';
}

/** The latest change made in this tab, offered back for undo until the person moves on. */
class LastChangeStore {
    current = $state<LastChange | null>(null);
    #undoing = false;
    #timer: ReturnType<typeof setTimeout> | undefined;

    /** Follows this tab's commits; returns the teardown. */
    start(): () => void {
        const stop = onLocalCommandCommitted((result, events) => {
            // The undo's own removals are not a new change to offer back.
            if (this.#undoing) return;
            void this.#show(result.batchId, result.eventIds, events);
        });
        return () => {
            stop();
            this.dismiss();
        };
    }

    async #show(batchId: string, eventIds: readonly string[], events: readonly ExtendedAppEvent[]): Promise<void> {
        const reversal = undoTargets(events);
        const label = await actionLabel(eventIds);
        this.current = { batchId, label, reversal, state: 'saved' };
        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.dismiss(), LIFETIME_MS);
    }

    dismiss(): void {
        clearTimeout(this.#timer);
        this.current = null;
    }

    async undo(): Promise<void> {
        const change = this.current;
        if (!change?.reversal || change.state !== 'saved') return;
        this.current = { ...change, state: 'undoing' };
        this.#undoing = true;
        try {
            // One submission per undone action, so a repeated click cannot remove twice.
            await executeLocalCommand(undoEvents(change.reversal), { submissionId: `undo:${change.batchId}` });
            if (this.current?.batchId === change.batchId) this.current = { ...change, state: 'undone' };
        } catch {
            if (this.current?.batchId === change.batchId) this.current = { ...change, state: 'failed' };
            return;
        } finally {
            this.#undoing = false;
        }
        await refreshPageData(...SYNC_INVALIDATION_TARGETS);
    }
}

export const lastChange = new LastChangeStore();
