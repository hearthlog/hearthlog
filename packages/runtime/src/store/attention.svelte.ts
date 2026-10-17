import { format } from 'date-fns';
import type { AttentionBadge, AttentionContribution, NavFigure } from '@hearthlog/contracts';
import { appClock } from '../runtime/view.js';

/**
 * Navigation badges and figures: counts of work that is late
 * (`AttentionContribution.badges`) and one live figure per place
 * (`AttentionContribution.figures`), supplied by the enabled modules. Both come
 * from SQL against the active log and refresh whenever events change; a failed
 * read keeps the previous values because they are advisory.
 */
class AttentionStore {
    badges = $state<AttentionBadge[]>([]);
    figures = $state<NavFigure[]>([]);
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
        // Read apart, so a failing figure never hides late work and the reverse.
        await Promise.all([
            (async () => {
                try {
                    const next = (await Promise.all(this.#sources.map((source) => source.badges?.({ today }) ?? []))).flat();
                    if (run === this.#run) this.badges = next;
                } catch {
                    // Keep the last known badges; the page itself still shows the details.
                }
            })(),
            (async () => {
                try {
                    const next = (await Promise.all(this.#sources.map((source) => source.figures?.({ today }) ?? []))).flat();
                    if (run === this.#run) this.figures = next;
                } catch {
                    // Keep the last known figures.
                }
            })(),
        ]);
    }

    /** Badge for a navigation destination or sub-page id, or null when nothing is waiting. */
    badge(id: string): AttentionBadge | null {
        return this.badges.find((badge) => badge.count > 0 && badge.ids.includes(id)) ?? null;
    }

    /** Live figure for a navigation destination or sub-page id, or null when the module shows none. */
    figure(id: string): NavFigure | null {
        return this.figures.find((figure) => figure.id === id) ?? null;
    }

    /** Total of all badges: the native app icon's badge. */
    get total(): number {
        return this.badges.reduce((sum, badge) => sum + badge.count, 0);
    }
}

export const attention = new AttentionStore();

export type AttentionTone = AttentionBadge['tone'];
