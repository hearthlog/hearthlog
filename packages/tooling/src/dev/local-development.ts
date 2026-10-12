import { readFileSync } from "node:fs";
import {
    chmod,
    mkdir,
    readFile,
    rename,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

export const DEFAULT_LOCAL_LEDGER_URL = "http://127.0.0.1:8787";
export const DEFAULT_LOCAL_LEDGER_CREDENTIAL_PATH =
    ".wrangler/development/st-local-ledger.json";

export interface LocalLedgerCredential {
    version: 1;
    baseUrl: string;
    appId: string;
    token: string;
    createdAt: string;
}

interface EnsureLocalLedgerOptions {
    adminToken: string;
    baseUrl?: string;
    credentialPath?: string;
    fetch?: typeof fetch;
}

export interface EnsureLocalLedgerResult {
    credential: LocalLedgerCredential;
    reused: boolean;
}

export function localGatewayOriginAllowed(
    origin: string | undefined,
    host: string | undefined,
): boolean {
    if (origin === undefined) return true;
    if (host === undefined) return false;
    try {
        const url = new URL(origin);
        return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            !url.username &&
            !url.password &&
            url.pathname === "/" &&
            !url.search &&
            !url.hash &&
            url.host.toLowerCase() === host.toLowerCase()
        );
    } catch {
        return false;
    }
}

export function localLedgerCredentialPath(
    projectRoot = process.cwd(),
): string {
    return path.resolve(
        projectRoot,
        process.env.LEDGER_LOCAL_CREDENTIAL_PATH ??
            DEFAULT_LOCAL_LEDGER_CREDENTIAL_PATH,
    );
}

export async function readLocalLedgerCredential(
    credentialPath = localLedgerCredentialPath(),
): Promise<LocalLedgerCredential | undefined> {
    try {
        return parseLocalLedgerCredential(
            JSON.parse(await readFile(credentialPath, "utf8")),
        );
    } catch {
        return undefined;
    }
}

export function readLocalLedgerCredentialSync(
    credentialPath = localLedgerCredentialPath(),
): LocalLedgerCredential | undefined {
    try {
        return parseLocalLedgerCredential(
            JSON.parse(readFileSync(credentialPath, "utf8")),
        );
    } catch {
        return undefined;
    }
}

export function parseLocalLedgerCredential(
    value: unknown,
): LocalLedgerCredential | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
        record.version !== 1 ||
        typeof record.baseUrl !== "string" ||
        !isHttpUrl(record.baseUrl) ||
        typeof record.appId !== "string" ||
        record.appId.length === 0 ||
        typeof record.token !== "string" ||
        record.token.length === 0 ||
        typeof record.createdAt !== "string" ||
        !Number.isFinite(Date.parse(record.createdAt))
    ) {
        return undefined;
    }
    return {
        version: 1,
        baseUrl: normalizeBaseUrl(record.baseUrl),
        appId: record.appId,
        token: record.token,
        createdAt: record.createdAt,
    };
}

export async function ensureLocalLedgerCredential(
    options: EnsureLocalLedgerOptions,
): Promise<EnsureLocalLedgerResult> {
    if (!options.adminToken) {
        throw new Error(
            "ADMIN_TOKEN is missing; configure ledger/.dev.vars before starting Vite",
        );
    }
    const baseUrl = normalizeBaseUrl(
        options.baseUrl ??
            process.env.LEDGER_LOCAL_URL ??
            DEFAULT_LOCAL_LEDGER_URL,
    );
    const credentialPath =
        options.credentialPath ?? localLedgerCredentialPath();
    const fetchImpl = options.fetch ?? fetch;

    await requireHealthyLedger(fetchImpl, baseUrl);

    const existing = await readLocalLedgerCredential(credentialPath);
    if (
        existing?.baseUrl === baseUrl &&
        (await credentialIsActive(fetchImpl, existing))
    ) {
        await chmod(credentialPath, 0o600);
        return { credential: existing, reused: true };
    }

    const response = await fetchImpl(new URL("/admin/v1/apps", baseUrl), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${options.adminToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            name:
                `st-local-${new Date().toISOString().replaceAll(/[^0-9]/g, "")}` +
                `-${crypto.randomUUID().slice(0, 8)}`,
        }),
    });
    if (!response.ok) {
        throw new Error(
            `Local Ledger app provisioning failed with HTTP ${response.status}`,
        );
    }
    const body: unknown = await response.json();
    const credential = credentialFromProvisioningResponse(body, baseUrl);
    await writeCredential(credentialPath, credential);
    return { credential, reused: false };
}

async function requireHealthyLedger(
    fetchImpl: typeof fetch,
    baseUrl: string,
): Promise<void> {
    let response: Response;
    try {
        response = await fetchImpl(new URL("/health", baseUrl));
    } catch {
        throw new Error(
            `Local Ledger is unavailable at ${baseUrl}; start pnpm ledger:dev first`,
        );
    }
    if (response.status !== 204) {
        throw new Error(
            `Local Ledger health check failed with HTTP ${response.status}`,
        );
    }
}

async function credentialIsActive(
    fetchImpl: typeof fetch,
    credential: LocalLedgerCredential,
): Promise<boolean> {
    try {
        const response = await fetchImpl(
            new URL("/session", credential.baseUrl),
            {
                headers: {
                    Authorization: `Bearer ${credential.token}`,
                },
            },
        );
        if (!response.ok) return false;
        const value: unknown = await response.json();
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            (value as Record<string, unknown>).appId === credential.appId
        );
    } catch {
        return false;
    }
}

function credentialFromProvisioningResponse(
    value: unknown,
    baseUrl: string,
): LocalLedgerCredential {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Local Ledger returned an invalid provisioning response");
    }
    const response = value as Record<string, unknown>;
    const app =
        response.app !== null &&
        typeof response.app === "object" &&
        !Array.isArray(response.app)
            ? response.app as Record<string, unknown>
            : undefined;
    if (
        typeof response.token !== "string" ||
        response.token.length === 0 ||
        typeof app?.id !== "string" ||
        app.id.length === 0
    ) {
        throw new Error("Local Ledger returned an invalid provisioning response");
    }
    return {
        version: 1,
        baseUrl,
        appId: app.id,
        token: response.token,
        createdAt: new Date().toISOString(),
    };
}

async function writeCredential(
    credentialPath: string,
    credential: LocalLedgerCredential,
): Promise<void> {
    const directory = path.dirname(credentialPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath =
        `${credentialPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(
        temporaryPath,
        `${JSON.stringify(credential, null, 2)}\n`,
        {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        },
    );
    await rename(temporaryPath, credentialPath);
    await chmod(credentialPath, 0o600);
}

function normalizeBaseUrl(value: string): string {
    if (!isHttpUrl(value)) {
        throw new Error(
            `LEDGER_LOCAL_URL must be an HTTP URL, received ${value}`,
        );
    }
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
}

function isHttpUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}
