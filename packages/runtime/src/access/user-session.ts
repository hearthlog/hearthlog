import { fetchAccessProtected } from './session.js';

export { ACCESS_LOGOUT_ENDPOINT } from './session.js';

export const LOCAL_USER_EMAIL = 'local@localhost';
export const USER_SESSION_ENDPOINT = '/api/session';

export interface UserSession {
    email: string;
}

export function isLocalDevelopmentHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export function parseUserSession(value: unknown): UserSession {
    if (
        !value ||
        typeof value !== 'object' ||
        !('email' in value) ||
        typeof value.email !== 'string' ||
        value.email.trim().length === 0
    ) {
        throw new Error('The user session response was invalid.');
    }

    return { email: value.email };
}

let currentUserEmail: Promise<string> | null = null;

/** The signed-in email, fetched once and shared by everything that needs it. */
export function cachedCurrentUserEmail(): Promise<string> {
    currentUserEmail ??= loadCurrentUserEmail().catch((error) => {
        // A failed lookup must not stick: the next caller tries again.
        currentUserEmail = null;
        throw error;
    });
    return currentUserEmail;
}

export async function loadCurrentUserEmail(
    hostname = typeof window !== 'undefined' ? window.location.hostname : '',
): Promise<string> {
    if (isLocalDevelopmentHostname(hostname)) {
        return LOCAL_USER_EMAIL;
    }

    const response = await fetchAccessProtected(USER_SESSION_ENDPOINT, {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
        throw new Error(`The user session request failed (${response.status}).`);
    }

    const session = parseUserSession(await response.json());
    return session.email;
}
