import { format } from 'date-fns';
import type { AttentionBadge, AttentionContribution } from '@hearthlog/contracts';
import { appClock } from '../runtime/view.js';

/**
 * Navigation badges: counts of work that is late, supplied by the enabled
 * modules (`AttentionContribution.badges`). Counts come from SQL against the
 * active log and refresh whenever events change; a failed read keeps the
 * previous badges because they are advisory.
 */
class AttentionStore {
    badges = $state<AttentionBadge[]>([]);
    #sources: readonly AttentionContribution[] = [];
    #run = 0;

    /** Sets the composed modules' contributions (once, from the root layout). */
    configure(sources: readonly AttentionContribution[]): void {
        this.#sources = sources;
    }

    /** Reminders for the native shell, from every module that has some. */
    async reminders(today: Date) {
        const lists = await Promise.all(this.#sources.map((source) => source.reminders?.({ today }) ?? []));
        return lists.flat();
    }

    async refresh(): Promise<void> {
        const run = ++this.#run;
        const today = format(appClock.now(), 'yyyy-MM-dd');
        try {
            const next = (await Promise.all(this.#sources.map((source) => source.badges?.({ today }) ?? []))).flat();
            if (run === this.#run) this.badges = next;
        } catch {
            // Keep the last known badges; the page itself still shows the details.
        }
    }

    /** Badge for a navigation destination or sub-page id, or null when nothing is waiting. */
    badge(id: string): AttentionBadge | null {
        return this.badges.find((badge) => badge.count > 0 && badge.ids.includes(id)) ?? null;
    }

    /** Total of all badges: the native app icon's badge. */
    get total(): number {
        return this.badges.reduce((sum, badge) => sum + badge.count, 0);
    }
}

export const attention = new AttentionStore();

export type AttentionTone = AttentionBadge['tone'];
