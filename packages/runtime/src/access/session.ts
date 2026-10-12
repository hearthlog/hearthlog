import { AuthenticationError } from '../ledger/errors.js';

/**
 * Cloudflare Access returns 401 for expired SPA sessions only when an AJAX
 * request opts into that behaviour. Keep the marker in one place so every
 * protected browser API request has the same contract.
 */
export const CLOUDFLARE_ACCESS_AJAX_HEADER = 'X-Requested-With';
export const CLOUDFLARE_ACCESS_AJAX_VALUE = 'XMLHttpRequest';

export class AccessSessionExpiredError extends AuthenticationError {
    constructor() {
        super(
            'Your Cloudflare Access session has expired. Sign in again to continue.',
            401,
            'access_session_expired',
        );
        this.name = 'AccessSessionExpiredError';
    }
}

export function withCloudflareAccessAjaxHeader(headers?: HeadersInit): Headers {
    const next = new Headers(headers);
    next.set(CLOUDFLARE_ACCESS_AJAX_HEADER, CLOUDFLARE_ACCESS_AJAX_VALUE);
    return next;
}

export function isAccessSessionExpiredResponse(
    response: Pick<Response, 'status' | 'type'> & {
        headers?: Pick<Headers, 'get'> | null;
    },
): boolean {
    if (response.type === 'opaqueredirect') return true;
    if (response.status !== 401) return false;
    // Application auth failures (unknown bearer token, forbidden log) share the
    // 401 status but always carry a JSON error body. Only a non-JSON 401 comes
    // from the Cloudflare Access edge itself.
    try {
        const contentType = response.headers?.get('content-type') ?? '';
        if (contentType.toLowerCase().includes('application/json')) return false;
    } catch {
        // An unreadable header map cannot prove this is an application error.
    }
    return true;
}

export interface AccessReauthenticationDependencies {
    currentUrl: () => string;
    isOnline: () => boolean;
    navigate: (url: string) => void;
}

/** Cloudflare Access endpoint that clears the session cookie (explicit sign-out). */
export const ACCESS_LOGOUT_ENDPOINT = '/cdn-cgi/access/logout';

/**
 * Marks a recovery navigation so it can never be answered from the service
 * worker cache. Recovery only works when the request reaches the Cloudflare
 * edge: the edge is what turns an unauthenticated request into the Access
 * login flow.
 */
export const ACCESS_REAUTH_QUERY_PARAM = '__stor_access_reauth';

/**
 * Bounds document reloads across page loads in the same tab. The in-memory
 * gate already coalesces concurrent failures within one page instance, but
 * after a reload the module state is fresh: if the session is still expired
 * (logged out, blocked login, stale cached shell) every boot would reload
 * again. Persisting the attempt count per tab bounds that loop; any
 * successful protected response proves the session is valid and resets it.
 * Once the budget is spent the app forces one more edge round-trip from the
 * application URL so Access renders its login page instead of parking the app.
 */
export const ACCESS_REAUTH_STORAGE_KEY = 'stor:access-reauth-attempts';
export const ACCESS_REAUTH_MAX_ATTEMPTS = 2;

export function getAccessReauthenticationAttempts(): number {
    try {
        if (typeof sessionStorage === 'undefined') return 0;
        const count = Number(sessionStorage.getItem(ACCESS_REAUTH_STORAGE_KEY));
        return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    } catch {
        return 0;
    }
}

export function clearAccessReauthenticationAttempts(): void {
    try {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.removeItem(ACCESS_REAUTH_STORAGE_KEY);
        }
    } catch {
        // Storage can be unavailable in a privacy-restricted context.
    }
}

function recordAccessReauthenticationAttempt(): void {
    try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(
            ACCESS_REAUTH_STORAGE_KEY,
            String(getAccessReauthenticationAttempts() + 1),
        );
    } catch {
        // Storage can be unavailable in a privacy-restricted context.
    }
}

/**
 * Coalesces the many concurrent API failures an expired session can produce
 * into one top-level navigation. A document navigation is deliberate: Access
 * can then render its own login flow instead of leaving the SPA in a partial
 * state.
 */
export function createAccessReauthenticationGate(
    dependencies: AccessReauthenticationDependencies,
): () => boolean {
    let navigationStarted = false;

    return () => {
        if (navigationStarted || !dependencies.isOnline()) return false;
        navigationStarted = true;
        dependencies.navigate(dependencies.currentUrl());
        return true;
    };
}

/**
 * Full-page navigation that restarts the Cloudflare Access login flow. A
 * recovery navigation must reach the edge, so the URL carries a one-shot
 * cache-busting parameter (the service worker excludes it as well). Never
 * use the logout endpoint for this: it only works while the browser still
 * holds an Access cookie and otherwise answers "No Access cookie found.
 * Please login first.", stranding the user outside the login flow.
 */
export function beginAccessLogin(returnTo: string = '/'): void {
    if (typeof window === 'undefined') return;
    const url = new URL(returnTo, window.location.origin);
    url.searchParams.set(ACCESS_REAUTH_QUERY_PARAM, String(Date.now()));
    window.location.assign(url.toString());
}

/**
 * Full-page navigation to the Cloudflare Access logout endpoint for an
 * explicit sign-out. The reauthentication attempt counter is cleared first
 * so the next app load may reload into the Access login flow instead of
 * staying parked on the expired-session banner. A plain document navigation
 * is deliberate (never fetch/SvelteKit routing): the service worker bypasses
 * /cdn-cgi/* and the edge clears the session cookie before rendering login.
 */
export function beginAccessLogout(returnTo: string = '/'): void {
    if (typeof window === 'undefined') return;
    clearAccessReauthenticationAttempts();
    const logoutUrl = new URL(ACCESS_LOGOUT_ENDPOINT, window.location.origin);
    // Supported by Cloudflare Access: after the session cookie is cleared,
    // return the user to the app root so the fresh login lands back in-app.
    logoutUrl.searchParams.set('return_url', new URL(returnTo, window.location.origin).toString());
    window.location.assign(logoutUrl.toString());
}

/**
 * "Sign in again" recovery for the parked expired-session state (reload
 * budget exhausted). Resets the budget and re-triggers the top-level
 * navigation into the Access login flow.
 */
export function retryAccessReauthentication(): boolean {
    clearAccessReauthenticationAttempts();
    // Reset the in-memory gates so this explicit user action always navigates.
    beginAccessReauthentication = null;
    accessRecoveryNavigationStarted = false;
    return requestAccessReauthentication();
}

let beginAccessReauthentication: (() => boolean) | null = null;
let accessRecoveryNavigationStarted = false;

export function requestAccessReauthentication(): boolean {
    if (typeof window === 'undefined') return false;
    // Offline attempts cannot reach Access and must not spend the reload
    // budget; the online event re-triggers this recovery.
    if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
    if (accessRecoveryNavigationStarted) return true;
    if (getAccessReauthenticationAttempts() >= ACCESS_REAUTH_MAX_ATTEMPTS) {
        // Reloads did not restore the session (for example a cached shell kept
        // booting without an edge round-trip). Force one final edge round-trip
        // from the app URL so Access renders its login page. The logout
        // endpoint cannot do this: without a cookie it answers "No Access
        // cookie found. Please login first." and strands the user.
        accessRecoveryNavigationStarted = true;
        clearAccessReauthenticationAttempts();
        beginAccessLogin(window.location.href);
        return true;
    }
    beginAccessReauthentication ??= createAccessReauthenticationGate({
        currentUrl: () => window.location.href,
        isOnline: () => navigator.onLine,
        navigate: (url) => beginAccessLogin(url),
    });
    if (!beginAccessReauthentication()) return false;
    // Only a navigation that actually started counts against the budget.
    recordAccessReauthenticationAttempt();
    return true;
}

export async function fetchAccessProtected(
    input: RequestInfo | URL,
    init: RequestInit = {},
): Promise<Response> {
    const response = await fetch(input, {
        ...init,
        cache: init.cache ?? 'no-store',
        credentials: init.credentials ?? 'same-origin',
        headers: withCloudflareAccessAjaxHeader(init.headers),
    });

    if (isAccessSessionExpiredResponse(response)) {
        requestAccessReauthentication();
        throw new AccessSessionExpiredError();
    }

    clearAccessReauthenticationAttempts();
    return response;
}
