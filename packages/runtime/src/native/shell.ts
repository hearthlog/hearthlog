/**
 * Bridge to the native Mac and iOS shell (`apple/`).
 *
 * The shell is a thin WKWebView host that loads this same site. It defines
 * `window.storShell` before any page script runs and listens on the `stor`
 * script message handler. In a browser both are absent, so every function here
 * does nothing and callers never branch on the platform.
 *
 * Only small values the page already shows cross the bridge: counts, dates,
 * titles and screen positions. Events, rows and credentials never do.
 */

export type ShellKind = 'mac' | 'ios';

export interface ShellInfo {
    readonly kind: ShellKind;
    readonly site: string;
    readonly version: number;
    /** Mac: points the window buttons take, so the sidebar can leave exactly that much room. */
    readonly lights?: number;
    /** Set by a native app's hidden engine web view (`./engine.svelte.ts`), which shows no page. */
    readonly role?: 'engine';
}

export interface ShellMenuEntry {
    id: string;
    title: string;
    path: string;
    /** A section's sub-pages; the Mac Dock menu shows them as a submenu. */
    children?: readonly ShellMenuEntry[];
}

export interface ShellReminder {
    id: string;
    title: string;
    body: string;
    /** Local wall-clock time, `YYYY-MM-DDTHH:mm`; the device's time zone applies. */
    at: string;
    /** Route opened when the notification is tapped. */
    path: string;
}

/** Events the shell sends to the page (`window` event `stor-shell`). */
export type ShellEvent =
    | { type: 'navigate'; path: string }
    | { type: 'toggle-sidebar' }
    | { type: 'resume' };

export const SHELL_EVENT = 'stor-shell';

declare global {
    interface Window {
        storShell?: ShellInfo;
        webkit?: { messageHandlers?: { stor?: { postMessage(message: unknown): void } } };
    }
}

export const shell: ShellInfo | null = typeof window === 'undefined' ? null : (window.storShell ?? null);

function post(type: string, body: Record<string, unknown> = {}): void {
    if (!shell) return;
    try {
        window.webkit?.messageHandlers?.stor?.postMessage({ type, body });
    } catch {
        // The shell is advisory: a failed message never blocks the page.
    }
}

export const shellApi = {
    /** Lets native chrome (window material, status bar, sheets) follow the page's theme. */
    appearance(preference: 'light' | 'dark' | 'system', resolved: 'light' | 'dark', background: string): void {
        post('appearance', { preference, resolved, background });
    },
    /** App icon badge: late work, the same count as the navigation badges. */
    badge(count: number): void {
        post('badge', { count });
    },
    /** Replaces every scheduled reminder with this list. */
    reminders(items: readonly ShellReminder[]): void {
        post('reminders', { items });
    },
    /** Menu bar entries (Mac): the sections the tenant has, and its create shortcuts. */
    menu(destinations: readonly ShellMenuEntry[], actions: readonly ShellMenuEntry[]): void {
        post('menu', { destinations, actions });
    },
    /** Where the window controls belong: left edge of the first one and the vertical centre, in CSS pixels. */
    lights(x: number, y: number): void {
        post('lights', { x, y });
    },
    /** Changes still waiting to upload; iOS keeps the app alive a little longer while there are some. */
    outbox(pending: number): void {
        post('outbox', { pending });
    },
    haptic(kind: 'success' | 'warning'): void {
        post('haptic', { kind });
    },
};

export function onShellEvent(handler: (event: ShellEvent) => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const listener = (event: Event) => handler((event as CustomEvent<ShellEvent>).detail);
    window.addEventListener(SHELL_EVENT, listener);
    return () => window.removeEventListener(SHELL_EVENT, listener);
}
