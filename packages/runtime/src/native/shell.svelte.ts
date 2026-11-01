import { goto } from '$app/navigation';
import { buildNavigation } from '@hearthlog/contracts/features/navigation';
import { FEATURES } from '@hearthlog/contracts/features/registry';
import { onShellEvent, shell, shellApi, type ShellMenuEntry } from './shell.js';
import { workspaceIsReady, workspaceReadiness } from '@hearthlog/ui/state/readiness.js';
import { appClock } from '../runtime/view.js';
import { attention } from '../store/attention.svelte.js';
import { eventLogFilename } from '../store/event-log.svelte.js';
import { events } from '../store/events.svelte.js';
import { notificationState } from '@hearthlog/ui/state/notifications.svelte.js';
import { syncStatus } from '../store/sync.svelte.js';
import { APPEARANCE_EVENT, appearance } from '../theme/appearance.svelte.js';
import { isFeatureEnabled, tenant } from '@hearthlog/contracts/tenant/config';

const REMINDER_DEBOUNCE_MS = 1_500;
/** An in-app route: absolute, same origin, never `//host`. */
function isAppPath(path: unknown): path is string {
    return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

function menuEntries(): { destinations: ShellMenuEntry[]; actions: ShellMenuEntry[] } {
    const destinations = buildNavigation(tenant).sections.map(({ id, label, path, children }) => ({
        id,
        title: label,
        path,
        children: children?.map((child) => ({ id: child.id, title: child.label, path: child.href })),
    }));
    const actions = FEATURES
        .filter((feature) => isFeatureEnabled(feature.id) && !feature.page?.nsfw)
        .flatMap((feature) => feature.commands.map((command) => ({
            id: command.id,
            title: command.label,
            path: command.href ?? `${feature.page?.path ?? '/'}${command.query ?? ''}`,
        })));
    return { destinations, actions };
}

async function refreshReminders(): Promise<void> {
    if (!workspaceIsReady()) return;
    shellApi.reminders(await attention.reminders(appClock.now()));
}

function reportAppearance(): void {
    const background = getComputedStyle(document.documentElement).getPropertyValue('--stor-bg').trim();
    shellApi.appearance(appearance.preference, appearance.resolved, background);
}

/**
 * Where the Mac window controls belong. The sidebar's brand row reserves an empty
 * `[data-stor-lights]` anchor for them, so the layout, not this code, decides the
 * position; it follows the sidebar while it opens, closes and resizes.
 */
function trackWindowControls(): () => void {
    let frame = 0;
    const report = () => {
        frame = 0;
        const anchor = document.querySelector('[data-stor-lights]');
        const rect = anchor?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        shellApi.lights(Math.round(rect.left * 2) / 2, rect.top + rect.height / 2);
    };
    const schedule = () => { frame ||= requestAnimationFrame(report); };
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    const sidebar = document.querySelector('[data-testid="desktop-sidebar"]');
    if (sidebar) observer.observe(sidebar);
    schedule();
    return () => {
        observer.disconnect();
        if (frame) cancelAnimationFrame(frame);
    };
}

/**
 * Connects the page to the native shell when there is one: native chrome follows the
 * theme, menus and the app badge mirror what the page knows, reminders are scheduled
 * on the device, and the shell can open routes. In a browser this returns at once.
 */
export function startNativeShell({ toggleSidebar }: { toggleSidebar: () => void }): (() => void) | undefined {
    if (!shell) return undefined;
    const cleanups: Array<() => void> = [];

    cleanups.push(onShellEvent((event) => {
        if (event.type === 'navigate') {
            if (isAppPath(event.path)) void goto(event.path);
        } else if (event.type === 'toggle-sidebar') {
            toggleSidebar();
        } else if (event.type === 'resume') {
            scheduleReminders();
        }
    }));

    window.addEventListener(APPEARANCE_EVENT, reportAppearance);
    cleanups.push(() => window.removeEventListener(APPEARANCE_EVENT, reportAppearance));
    reportAppearance();

    const { destinations, actions } = menuEntries();
    shellApi.menu(destinations, actions);

    if (shell.kind === 'mac') {
        cleanups.push(trackWindowControls());
    }

    let reminderTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReminders = () => {
        clearTimeout(reminderTimer);
        reminderTimer = setTimeout(() => { void refreshReminders().catch(() => undefined); }, REMINDER_DEBOUNCE_MS);
    };
    cleanups.push(() => clearTimeout(reminderTimer));
    // The date moves on while the app sleeps, so plan again whenever it wakes.
    const onVisible = () => { if (document.visibilityState === 'visible') scheduleReminders(); };
    document.addEventListener('visibilitychange', onVisible);
    cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
    cleanups.push(workspaceReadiness.subscribe((state) => { if (state.ready) scheduleReminders(); }));

    let lastHaptic = '';
    cleanups.push($effect.root(() => {
        $effect(() => { shellApi.badge(attention.total); });
        $effect(() => { shellApi.outbox(syncStatus.pendingUploads); });
        $effect(() => {
            const latest = notificationState.items.at(-1);
            if (!latest || latest.id === lastHaptic) return;
            lastHaptic = latest.id;
            if (latest.type === 'success') shellApi.haptic('success');
            else if (latest.type === 'error') shellApi.haptic('warning');
        });
        // Re-plan after every event change and log switch.
        $effect(() => {
            void events.updatedAt;
            void eventLogFilename.value;
            scheduleReminders();
        });
    }));

    return () => cleanups.forEach((cleanup) => cleanup());
}
