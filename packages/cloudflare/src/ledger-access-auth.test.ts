import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, SignJWT } from "jose";

import {
    authorizeAccessRequest,
    authorizeLedgerAdminRequest,
    LedgerAdminAuthorizationError,
    LedgerAdminConfigurationError,
    verifyLedgerAdminJwt,
    verifyStorJwt,
    type LedgerAdminJwtConfig,
    type StorJwtConfig,
} from "./access-auth";

const issuer = "https://stor.cloudflareaccess.com";
const audience = "ledger-admin-audience";
const email = "owner@example.com";
const config: LedgerAdminJwtConfig = { audience, email, issuer };

const storConfig: StorJwtConfig = {
    audience,
    allowedEmails: ["user@example.com", "other@example.com"],
    issuer,
};

let keyPair: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
    keyPair = await generateKeyPair("RS256");
});

describe("Ledger Access authorization", () => {
    it("rejects a missing general Access assertion before contacting JWKS", async () => {
        await expect(
            authorizeAccessRequest(
                new Request("https://stor.example/api/session"),
                {
                    CF_ACCESS_APP_AUD: audience,
                    CF_ACCESS_TEAM_DOMAIN: issuer,
                },
            ),
        ).rejects.toBeInstanceOf(LedgerAdminAuthorizationError);
    });

    it.each([
        ["audience", { CF_ACCESS_APP_AUD: "" }],
        ["team domain", { CF_ACCESS_TEAM_DOMAIN: "" }],
    ])("rejects missing general Access %s configuration", async (_label, missing) => {
        await expect(
            authorizeAccessRequest(
                new Request("https://stor.example/api/session", {
                    headers: { "Cf-Access-Jwt-Assertion": "access-jwt" },
                }),
                {
                    CF_ACCESS_APP_AUD: audience,
                    CF_ACCESS_TEAM_DOMAIN: issuer,
                    ...missing,
                },
            ),
        ).rejects.toBeInstanceOf(LedgerAdminConfigurationError);
    });

    it("accepts a signed Access application token for the configured administrator", async () => {
        const token = await accessToken();

        await expect(
            verifyLedgerAdminJwt(token, config, keyPair.publicKey),
        ).resolves.toEqual({ email });
    });

    it("uses the same signed Access guarantees for the general stor application", async () => {
        await expect(
            verifyStorJwt(
                await accessToken({ email: "user@example.com" }),
                storConfig,
                keyPair.publicKey,
            ),
        ).resolves.toEqual({ email: "user@example.com" });
    });

    it("matches stor emails case-insensitively against the allow list", async () => {
        await expect(
            verifyStorJwt(
                await accessToken({ email: "OTHER@EXAMPLE.COM" }),
                storConfig,
                keyPair.publicKey,
            ),
        ).resolves.toEqual({ email: "OTHER@EXAMPLE.COM" });
    });

    it("rejects a stor token whose email is not on the allow list", async () => {
        await expect(
            verifyStorJwt(await accessToken(), storConfig, keyPair.publicKey),
        ).rejects.toBeInstanceOf(LedgerAdminAuthorizationError);
    });

    it.each([
        ["issuer", { issuer: "https://other.cloudflareaccess.com" }],
        ["audience", { audience: "other-audience" }],
        ["type", { type: "org" }],
        ["email", { email: "someone@example.com" }],
        ["expiry", { expiresAt: Math.floor(Date.now() / 1000) - 60 }],
        ["missing expiry", { includeExpiry: false }],
    ])("rejects a token with the wrong %s", async (_label, overrides) => {
        const token = await accessToken(overrides);

        await expect(
            verifyLedgerAdminJwt(token, config, keyPair.publicKey),
        ).rejects.toBeDefined();
    });

    it("rejects a token signed by another key", async () => {
        const otherKeyPair = await generateKeyPair("RS256");
        const token = await accessToken({}, otherKeyPair.privateKey);

        await expect(
            verifyLedgerAdminJwt(token, config, keyPair.publicKey),
        ).rejects.toBeDefined();
    });

    it("rejects missing Access assertions before contacting JWKS", async () => {
        await expect(
            authorizeLedgerAdminRequest(
                new Request("https://stor.example/api/ledger/admin/v1/session"),
                {
                    CF_ACCESS_ADMIN_AUD: audience,
                    CF_ACCESS_TEAM_DOMAIN: issuer,
                    LEDGER_ADMIN_EMAIL: email,
                },
            ),
        ).rejects.toBeInstanceOf(LedgerAdminAuthorizationError);
    });

    it.each([
        ["audience", { CF_ACCESS_ADMIN_AUD: "" }],
        ["team domain", { CF_ACCESS_TEAM_DOMAIN: "" }],
        ["administrator email", { LEDGER_ADMIN_EMAIL: "" }],
    ])("rejects a missing %s configuration value", async (_label, missing) => {
        await expect(
            authorizeLedgerAdminRequest(
                new Request("https://stor.example/api/ledger/admin/v1/session", {
                    headers: { "Cf-Access-Jwt-Assertion": "access-jwt" },
                }),
                {
                    CF_ACCESS_ADMIN_AUD: audience,
                    CF_ACCESS_TEAM_DOMAIN: issuer,
                    LEDGER_ADMIN_EMAIL: email,
                    ...missing,
                },
            ),
        ).rejects.toBeInstanceOf(LedgerAdminConfigurationError);
    });

    it("rejects invalid verifier configuration", async () => {
        await expect(
            verifyLedgerAdminJwt(
                await accessToken(),
                { ...config, issuer: "http://stor.cloudflareaccess.com" },
                keyPair.publicKey,
            ),
        ).rejects.toBeInstanceOf(LedgerAdminConfigurationError);
    });
});

async function accessToken(
    overrides: {
        audience?: string;
        email?: string;
        expiresAt?: number;
        includeExpiry?: boolean;
        issuer?: string;
        type?: string;
    } = {},
    privateKey = keyPair.privateKey,
): Promise<string> {
    let token = new SignJWT({
        email: overrides.email ?? email,
        type: overrides.type ?? "app",
    })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(overrides.issuer ?? issuer)
        .setAudience(overrides.audience ?? audience)
        .setIssuedAt();
    if (overrides.includeExpiry !== false) {
        token = token.setExpirationTime(
            overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3_600,
        );
    }
    return token.sign(privateKey);
}
