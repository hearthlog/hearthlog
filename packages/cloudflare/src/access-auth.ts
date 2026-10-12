import {
    createRemoteJWKSet,
    jwtVerify,
    type JWTVerifyGetKey,
    type KeyInput,
} from "jose";

export type LedgerAdminAuthEnv = Pick<
    Env,
    "CF_ACCESS_ADMIN_AUD" | "CF_ACCESS_TEAM_DOMAIN" | "LEDGER_ADMIN_EMAIL"
>;
export type AccessAuthEnv = Pick<
    Env,
    "CF_ACCESS_APP_AUD" | "CF_ACCESS_TEAM_DOMAIN"
>;
export type StorAuthEnv = Pick<
    Env,
    "CF_ACCESS_APP_AUD" | "CF_ACCESS_TEAM_DOMAIN" | "STOR_AUTHORIZED_EMAILS"
>;

export type ServiceAuthEnv = Pick<
    Env,
    "CF_ACCESS_INTEGRATIONS_AUD" | "CF_ACCESS_TEAM_DOMAIN"
>;

export interface LedgerAdminIdentity {
    email: string;
}

/** A non-human caller: the Access service token's client id. */
export interface ServiceIdentity {
    clientId: string;
}

export interface LedgerAdminJwtConfig {
    audience: string;
    email: string;
    issuer: string;
}

export interface StorJwtConfig {
    audience: string;
    /** Every email allowed through the general stor Access application. */
    allowedEmails: readonly string[];
    issuer: string;
}

type VerificationKey = KeyInput | JWTVerifyGetKey;
const accessJwks = new Map<string, JWTVerifyGetKey>();

export class LedgerAdminConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LedgerAdminConfigurationError";
    }
}

export class LedgerAdminAuthorizationError extends Error {
    constructor() {
        super("Ledger administrator authorization failed");
        this.name = "LedgerAdminAuthorizationError";
    }
}

/** Verify the identity issued by the Access application protecting the app. */
export async function authorizeAccessRequest(
    request: Request,
    env: AccessAuthEnv,
): Promise<LedgerAdminIdentity> {
    const config = {
        audience: requiredConfig(env.CF_ACCESS_APP_AUD, "CF_ACCESS_APP_AUD"),
        issuer: normalizeIssuer(env.CF_ACCESS_TEAM_DOMAIN),
    };
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) throw new LedgerAdminAuthorizationError();

    const certsUrl = new URL("/cdn-cgi/access/certs", config.issuer);
    let jwks = accessJwks.get(certsUrl.href);
    if (!jwks) {
        jwks = createRemoteJWKSet(certsUrl, { timeoutDuration: 5_000 });
        accessJwks.set(certsUrl.href, jwks);
    }

    try {
        return await verifyAccessJwt(token, config, jwks);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) throw error;
        throw new LedgerAdminAuthorizationError();
    }
}

/**
 * Verify a service-token identity issued by the integrations Access
 * application. Its audience differs from the main application's, so this never
 * accepts a browser session and `authorizeStorRequest` never accepts a token.
 */
export async function authorizeServiceRequest(
    request: Request,
    env: ServiceAuthEnv,
): Promise<ServiceIdentity> {
    const config = {
        audience: requiredConfig(env.CF_ACCESS_INTEGRATIONS_AUD, "CF_ACCESS_INTEGRATIONS_AUD"),
        issuer: normalizeIssuer(env.CF_ACCESS_TEAM_DOMAIN),
    };
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) throw new LedgerAdminAuthorizationError();

    const certsUrl = new URL("/cdn-cgi/access/certs", config.issuer);
    let jwks = accessJwks.get(certsUrl.href);
    if (!jwks) {
        jwks = createRemoteJWKSet(certsUrl, { timeoutDuration: 5_000 });
        accessJwks.set(certsUrl.href, jwks);
    }

    try {
        return await verifyServiceJwt(token, config, jwks);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) throw error;
        throw new LedgerAdminAuthorizationError();
    }
}

export async function verifyServiceJwt(
    token: string,
    config: { audience: string; issuer: string },
    key: VerificationKey,
): Promise<ServiceIdentity> {
    const { payload } = await jwtVerify(token, key, {
        algorithms: ["RS256"],
        audience: requiredConfig(config.audience, "access audience"),
        issuer: normalizeIssuer(config.issuer),
    });
    if (
        typeof payload.exp !== "number" ||
        typeof payload.common_name !== "string" ||
        payload.common_name.length === 0
    ) {
        throw new LedgerAdminAuthorizationError();
    }
    return { clientId: payload.common_name };
}

export async function authorizeLedgerAdminRequest(
    request: Request,
    env: LedgerAdminAuthEnv,
): Promise<LedgerAdminIdentity> {
    const config = accessJwtConfig(env);
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) throw new LedgerAdminAuthorizationError();

    const certsUrl = new URL("/cdn-cgi/access/certs", config.issuer);
    let jwks = accessJwks.get(certsUrl.href);
    if (!jwks) {
        jwks = createRemoteJWKSet(certsUrl, { timeoutDuration: 5_000 });
        accessJwks.set(certsUrl.href, jwks);
    }

    try {
        return await verifyLedgerAdminJwt(token, config, jwks);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) throw error;
        throw new LedgerAdminAuthorizationError();
    }
}

export async function authorizeStorRequest(
    request: Request,
    env: StorAuthEnv,
): Promise<LedgerAdminIdentity> {
    const config: StorJwtConfig = {
        audience: requiredConfig(env.CF_ACCESS_APP_AUD, "CF_ACCESS_APP_AUD"),
        allowedEmails: storAllowedEmails(env),
        issuer: normalizeIssuer(env.CF_ACCESS_TEAM_DOMAIN),
    };
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) throw new LedgerAdminAuthorizationError();

    const certsUrl = new URL("/cdn-cgi/access/certs", config.issuer);
    let jwks = accessJwks.get(certsUrl.href);
    if (!jwks) {
        jwks = createRemoteJWKSet(certsUrl, { timeoutDuration: 5_000 });
        accessJwks.set(certsUrl.href, jwks);
    }

    try {
        return await verifyStorJwt(token, config, jwks);
    } catch (error) {
        if (error instanceof LedgerAdminConfigurationError) throw error;
        throw new LedgerAdminAuthorizationError();
    }
}

/**
 * The authorized email list: STOR_AUTHORIZED_EMAILS (comma-separated, from
 * tenants.json authorizedEmails). An empty list cannot authorize anyone, so
 * it is a configuration error rather than a silent deny-all.
 */
function storAllowedEmails(env: StorAuthEnv): string[] {
    const emails = (env.STOR_AUTHORIZED_EMAILS ?? "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0);
    if (emails.length === 0) {
        throw new LedgerAdminConfigurationError(
            "STOR_AUTHORIZED_EMAILS must list at least one authorized email",
        );
    }
    return emails;
}

export async function verifyStorJwt(
    token: string,
    config: StorJwtConfig,
    key: VerificationKey,
): Promise<LedgerAdminIdentity> {
    const { email } = await verifyAccessJwt(token, config, key);
    if (!config.allowedEmails.map((value) => value.toLowerCase()).includes(email.toLowerCase())) {
        throw new LedgerAdminAuthorizationError();
    }
    return { email };
}

export async function verifyLedgerAdminJwt(
    token: string,
    config: LedgerAdminJwtConfig,
    key: VerificationKey,
): Promise<LedgerAdminIdentity> {
    const { email } = await verifyAccessJwt(token, config, key);
    const expectedEmail = requiredConfig(
        config.email,
        "LEDGER_ADMIN_EMAIL",
    ).toLowerCase();
    if (email.toLowerCase() !== expectedEmail) {
        throw new LedgerAdminAuthorizationError();
    }
    return { email };
}

/** Shared Access JWT checks (signature, issuer, audience, expiry, token type). */
async function verifyAccessJwt(
    token: string,
    config: { audience: string; issuer: string },
    key: VerificationKey,
): Promise<{ email: string }> {
    const issuer = normalizeIssuer(config.issuer);
    const audience = requiredConfig(config.audience, "access audience");

    const { payload } = await jwtVerify(token, key, {
        algorithms: ["RS256"],
        audience,
        issuer,
    });

    if (
        typeof payload.exp !== "number" ||
        payload.type !== "app" ||
        typeof payload.email !== "string"
    ) {
        throw new LedgerAdminAuthorizationError();
    }

    return { email: payload.email };
}

function accessJwtConfig(env: LedgerAdminAuthEnv): LedgerAdminJwtConfig {
    return {
        audience: requiredConfig(
            env.CF_ACCESS_ADMIN_AUD,
            "CF_ACCESS_ADMIN_AUD",
        ),
        email: requiredConfig(env.LEDGER_ADMIN_EMAIL, "LEDGER_ADMIN_EMAIL"),
        issuer: normalizeIssuer(env.CF_ACCESS_TEAM_DOMAIN),
    };
}

function normalizeIssuer(value: string): string {
    const issuer = requiredConfig(value, "CF_ACCESS_TEAM_DOMAIN").replace(
        /\/+$/,
        "",
    );
    let url: URL;
    try {
        url = new URL(issuer);
    } catch {
        throw new LedgerAdminConfigurationError(
            "CF_ACCESS_TEAM_DOMAIN must be an HTTPS URL",
        );
    }
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
    ) {
        throw new LedgerAdminConfigurationError(
            "CF_ACCESS_TEAM_DOMAIN must be an HTTPS origin",
        );
    }
    return url.origin;
}

function requiredConfig(value: string | undefined, name: string): string {
    const normalized = value?.trim();
    if (!normalized) {
        throw new LedgerAdminConfigurationError(`${name} is not configured`);
    }
    return normalized;
}
