import {
    type AccessClaims,
    parseAccessClaims,
} from "./contracts";

const ACCESS_PREFIX = "ledger_v1";

export const SOCKET_PROTOCOL = "ledger.v1";

export function bearerToken(request: Request): string {
    const value = request.headers.get("authorization");
    if (!value?.startsWith("Bearer ") || value.length === "Bearer ".length) {
        throw new Error("missing bearer token");
    }
    return value.slice("Bearer ".length);
}

export async function authorizeAdmin(
    request: Request,
    env: Env,
): Promise<void> {
    const supplied = bearerToken(request);
    if (!(await constantTimeStrings(supplied, env.ADMIN_TOKEN))) {
        throw new Error("invalid administrator token");
    }
}

export async function issueAccess(
    env: Env,
    appId: string,
    principalId: string,
    generation: number,
): Promise<string> {
    const claims: AccessClaims = {
        version: 1,
        kind: "access",
        appId,
        principalId,
        generation,
        keyId: currentKeyId(env),
    };
    return sign(env, ACCESS_PREFIX, claims);
}

export async function verifyAccess(
    env: Env,
    token: string,
): Promise<AccessClaims> {
    return parseAccessClaims(await verify(env, ACCESS_PREFIX, token));
}

export function requestOrigin(request: Request): string | null {
    return request.headers.get("origin");
}

export function originAllowed(env: Env, origin: string | null): boolean {
    if (origin === null) return true;
    return env.ALLOWED_ORIGINS.split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .includes(origin);
}

export async function constantTimeStrings(
    left: string,
    right: string,
): Promise<boolean> {
    const encoder = new TextEncoder();
    const [leftHash, rightHash] = await Promise.all([
        crypto.subtle.digest("SHA-256", encoder.encode(left)),
        crypto.subtle.digest("SHA-256", encoder.encode(right)),
    ]);
    return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function sign(
    env: Env,
    prefix: string,
    claims: AccessClaims,
): Promise<string> {
    const payload = encodeBase64Url(
        new TextEncoder().encode(JSON.stringify(claims)),
    );
    const message = `${prefix}.${payload}`;
    const signature = await hmac(currentKey(env), message);
    return `${message}.${encodeBase64Url(signature)}`;
}

async function verify(
    env: Env,
    prefix: string,
    token: string,
): Promise<unknown> {
    const parts = token.split(".");
    if (
        parts.length !== 3 ||
        parts[0] !== prefix ||
        !parts[1] ||
        !parts[2]
    ) {
        throw new Error("invalid signed token");
    }

    const payloadBytes = decodeBase64Url(parts[1]);
    const value: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("invalid token payload");
    }
    const keyId = (value as Record<string, unknown>).keyId;
    if (typeof keyId !== "string") throw new Error("missing token key id");

    const expected = await hmac(verificationKey(env, keyId), `${prefix}.${parts[1]}`);
    const supplied = decodeBase64Url(parts[2]);
    if (
        supplied.byteLength !== expected.byteLength ||
        !crypto.subtle.timingSafeEqual(supplied, expected)
    ) {
        throw new Error("invalid token signature");
    }
    return value;
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(key),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    return new Uint8Array(
        await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)),
    );
}

function currentKey(env: Env): string {
    if (new TextEncoder().encode(env.TOKEN_SIGNING_KEY_CURRENT).byteLength < 32) {
        throw new Error(
            "TOKEN_SIGNING_KEY_CURRENT must contain at least 32 bytes",
        );
    }
    return env.TOKEN_SIGNING_KEY_CURRENT;
}

function currentKeyId(env: Env): string {
    const keyId = env.TOKEN_SIGNING_KEY_ID.trim();
    if (!keyId) throw new Error("TOKEN_SIGNING_KEY_ID is empty");
    return keyId;
}

function verificationKey(env: Env, keyId: string): string {
    if (keyId === currentKeyId(env)) return currentKey(env);
    if (
        env.TOKEN_SIGNING_PREVIOUS_KEY_ID &&
        keyId === env.TOKEN_SIGNING_PREVIOUS_KEY_ID &&
        env.TOKEN_SIGNING_KEY_PREVIOUS
    ) {
        return env.TOKEN_SIGNING_KEY_PREVIOUS;
    }
    throw new Error("unknown signing key id");
}

function encodeBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
    try {
        const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
        const padded = normalized.padEnd(
            normalized.length + ((4 - (normalized.length % 4)) % 4),
            "=",
        );
        return Uint8Array.from(atob(padded), (character) =>
            character.charCodeAt(0),
        );
    } catch {
        throw new Error("invalid base64url value");
    }
}
