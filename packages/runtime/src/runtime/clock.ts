import { invalidateAll } from '$app/navigation';
import { isSameDay, startOfTomorrow } from 'date-fns';
import { advanceReadTargetClock } from './read-coordinator.js';
import { appClock } from './view.js';

/**
 * Keeps the workspace clock current while a tab stays open: it advances when
 * the tab becomes visible and at local midnight, and pages reload their data
 * when the date changes so "today" moves with it.
 */
export function startWorkspaceClock(): () => void {
    let midnight: ReturnType<typeof setTimeout> | undefined;

    async function advance(): Promise<void> {
        const previous = appClock.now();
        const now = new Date();
        if (!await advanceReadTargetClock(now)) return;
        if (!isSameDay(previous, now)) await invalidateAll();
    }

    function scheduleMidnight(): void {
        clearTimeout(midnight);
        // A second past midnight, so the new date is certain.
        midnight = setTimeout(() => {
            void advance();
            scheduleMidnight();
        }, startOfTomorrow().getTime() - Date.now() + 1_000);
    }

    function handleVisibility(): void {
        if (document.visibilityState !== 'visible') return;
        void advance();
        // Timers in hidden tabs are throttled; re-arm from the real time.
        scheduleMidnight();
    }

    document.addEventListener('visibilitychange', handleVisibility);
    scheduleMidnight();
    return () => {
        clearTimeout(midnight);
        document.removeEventListener('visibilitychange', handleVisibility);
    };
}
