import { DurableObject } from "cloudflare:workers";

import { issueAccess } from "./auth";
import { decodeRpc, parseUuid } from "./contracts";
import { LedgerError, normalizeError, validationError } from "./errors";
import { type RpcResult, type RpcSuccess, rpcCall, rpcSuccess } from "./rpc";
import { NEW_APPLICATION_POLICY, type EventPolicy } from "./event-validation";
import type { Fence, FenceRequest } from "./fence";
import { migrateAppRegistry } from "./schema";
import { sqliteExport } from "./sqlite-export";
import {
    type ApplicationSummary,
    type ApplicationTokenResponse,
    type CreateApplicationRequest,
    createApplicationBody,
} from "./schemas";

interface ApplicationRow extends Record<string, SqlStorageValue> {
    id: string;
    name: string;
    created_at: string;
    revoked_at: string | null;
    active_principal_id: string;
    principal_generation: number;
    active_token_created_at: string | null;
    provisioning_state: string;
}

export class AppRegistry extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        this.ctx.blockConcurrencyWhile(async () => {
            migrateAppRegistry(this.ctx.storage);
        });
    }

    async health(): Promise<RpcResult<null>> {
        return rpcCall(() => {
            this.ctx.storage.sql.exec("SELECT 1");
            return rpcSuccess(null, 204);
        });
    }

    async administratorExportSqlite(): Promise<Response> {
        return sqliteExport(
            this.ctx.storage,
            `ledger-registry-${new Date().toISOString().replaceAll(":", "-")}`,
        );
    }

    async listApplications(): Promise<
        RpcResult<{ apps: ApplicationSummary[] }>
    > {
        return rpcCall(() => rpcSuccess(this.list()));
    }

    async getApplication(
        appId: string,
    ): Promise<RpcResult<ApplicationSummary>> {
        return rpcCall(() => {
            const current = this.get(parseUuid(appId, "application id"));
            if (!current || current.provisioning_state !== "active") {
                throw new LedgerError(404, {
                    error: "application not found",
                    code: "not_found",
                });
            }
            return rpcSuccess(rowSummary(current));
        });
    }

    async createApplication(
        payload: CreateApplicationRequest,
    ): Promise<RpcResult<ApplicationTokenResponse>> {
        return rpcCall(() =>
            this.create(
                decodeRpc(
                    createApplicationBody,
                    payload,
                    "create application request",
                ),
            ),
        );
    }

    /**
     * Starts an identity-preserving import: the application is created under
     * its original ID, empty, with nobody able to use it (no token exists) until
     * `finishImport`. Only an empty Ledger accepts one.
     */
    async beginImport(payload: {
        id: string;
        name: string;
        createdAt: string;
        policy: string | null;
    }): Promise<RpcResult<{ id: string; name: string }>> {
        return rpcCall(async () => {
            const appId = parseUuid(payload.id, "application id");
            const name = payload.name.trim();
            if (!name) throw validationError("name must not be empty");
            const existing = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM applications").toArray()[0]!.n;
            if (existing > 0) {
                throw new LedgerError(409, {
                    error: "Conflict",
                    code: "ledger_not_empty",
                    message: "An identity-preserving import needs an empty Ledger",
                });
            }
            const principalId = crypto.randomUUID();
            this.ctx.storage.sql.exec(
                `INSERT INTO applications (id, name, created_at, active_principal_id, principal_generation,
                    active_token_created_at, provisioning_state)
                 VALUES (?, ?, ?, ?, 1, ?, 'importing')`,
                appId, name, payload.createdAt, principalId, payload.createdAt,
            );
            const response = await this.env.LEDGER_APP.getByName(appId).initializeApplication({
                appId, name, principalId, generation: 1, createdAt: payload.createdAt,
                ...(payload.policy ? { eventPolicy: payload.policy } : {}),
                importing: true,
            });
            if (!response.ok) {
                this.ctx.storage.sql.exec("DELETE FROM applications WHERE id = ?", appId);
                throw new LedgerError(500, { error: "import could not start", code: "import_failed" });
            }
            return rpcSuccess({ id: appId, name }, 201);
        });
    }

    /** The application, if it is still waiting for its import. */
    async importingApplication(appId: string): Promise<RpcResult<{ id: string }>> {
        return rpcCall(() => {
            const current = this.get(parseUuid(appId, "application id"));
            if (!current || current.provisioning_state !== "importing") {
                throw new LedgerError(404, { error: "no import in progress", code: "not_found" });
            }
            return rpcSuccess({ id: current.id });
        });
    }

    /** Throws away a half-finished import, so the Ledger is empty again and the import can be retried. */
    async abortImport(appId: string): Promise<RpcResult<null>> {
        return rpcCall(async () => {
            const id = parseUuid(appId, "application id");
            const current = this.get(id);
            if (!current || current.provisioning_state !== "importing") {
                throw new LedgerError(404, { error: "no import in progress", code: "not_found" });
            }
            const response = await this.env.LEDGER_APP.getByName(id).abortImport(id);
            if (!response.ok) throw new LedgerError(response.status, response.body);
            this.ctx.storage.sql.exec("DELETE FROM applications WHERE id = ?", id);
            return rpcSuccess(null, 204);
        });
    }

    /** Opens an imported application once its history matches what the source reported. */
    async finishImport(
        appId: string,
        expected: { logs: Array<{ id: string; headVersion: number }> },
    ): Promise<RpcResult<{ logs: number; events: number }>> {
        return rpcCall(async () => {
            const id = parseUuid(appId, "application id");
            const current = this.get(id);
            if (!current || current.provisioning_state !== "importing") {
                throw new LedgerError(404, { error: "no import in progress", code: "not_found" });
            }
            const response = await this.env.LEDGER_APP.getByName(id).finishImport(id, expected);
            if (!response.ok) throw new LedgerError(response.status, response.body);
            this.ctx.storage.sql.exec("UPDATE applications SET provisioning_state = 'active' WHERE id = ?", id);
            return rpcSuccess(response.body);
        });
    }

    async setApplicationFence(appId: string, request: FenceRequest): Promise<RpcResult<{ fence: Fence | null }>> {
        return rpcCall(async () => {
            this.activeApplication(parseUuid(appId, "application id"));
            const response = await this.env.LEDGER_APP.getByName(appId).setFence(request);
            if (!response.ok) throw new LedgerError(response.status, response.body);
            return rpcSuccess(response.body);
        });
    }

    async getApplicationFence(appId: string): Promise<RpcResult<{ fence: Fence | null }>> {
        return rpcCall(async () => {
            this.activeApplication(parseUuid(appId, "application id"));
            const response = await this.env.LEDGER_APP.getByName(appId).getFence();
            if (!response.ok) throw new LedgerError(response.status, response.body);
            return rpcSuccess(response.body);
        });
    }

    async setApplicationPolicy(
        appId: string,
        policy: EventPolicy,
    ): Promise<RpcResult<EventPolicy>> {
        return rpcCall(async () => {
            this.activeApplication(parseUuid(appId, "application id"));
            const response = await this.env.LEDGER_APP.getByName(appId).setEventPolicy(policy);
            if (!response.ok) throw new LedgerError(500, { error: "policy update failed", code: "policy_failed" });
            return rpcSuccess(policy);
        });
    }

    async getApplicationPolicy(
        appId: string,
    ): Promise<RpcResult<{ policy: EventPolicy | null }>> {
        return rpcCall(async () => {
            this.activeApplication(parseUuid(appId, "application id"));
            const response = await this.env.LEDGER_APP.getByName(appId).getEventPolicy();
            if (!response.ok) throw new LedgerError(500, { error: "policy read failed", code: "policy_failed" });
            return rpcSuccess(response.body);
        });
    }

    async rotateApplicationToken(
        appId: string,
    ): Promise<RpcResult<ApplicationTokenResponse>> {
        return rpcCall(() => this.rotate(parseUuid(appId, "application id")));
    }

    async revokeApplication(
        appId: string,
    ): Promise<RpcResult<ApplicationSummary>> {
        return rpcCall(() => this.revoke(parseUuid(appId, "application id")));
    }

    private list(): { apps: ApplicationSummary[] } {
        const apps = this.ctx.storage.sql
            .exec<ApplicationRow>(
                `SELECT id, name, created_at, revoked_at, active_principal_id,
                        principal_generation, active_token_created_at,
                        provisioning_state
                 FROM applications
                 WHERE provisioning_state = 'active'
                 ORDER BY created_at`,
            )
            .toArray()
            .map(rowSummary);
        return { apps };
    }

    private async create(
        payload: CreateApplicationRequest,
    ): Promise<RpcSuccess<ApplicationTokenResponse>> {
        const name = payload.name.trim();
        if (!name) {
            throw validationError("name must not be empty");
        }
        const appId = crypto.randomUUID();
        const principalId = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        this.ctx.storage.transactionSync(() => {
            const existing = this.ctx.storage.sql
                .exec<{
                    provisioning_state: string;
                }>(
                    "SELECT provisioning_state FROM applications WHERE name = ?",
                    name,
                )
                .toArray()[0];
            if (existing && existing.provisioning_state !== "failed") {
                throw new LedgerError(409, {
                    error: "application name already exists",
                    code: "app_name_conflict",
                });
            }
            // A failed attempt never issued a usable credential; release its name.
            if (existing) {
                this.ctx.storage.sql.exec(
                    `DELETE FROM applications
                     WHERE name = ? AND provisioning_state = 'failed'`,
                    name,
                );
            }
            this.ctx.storage.sql.exec(
                `INSERT INTO applications (
                    id, name, created_at, active_principal_id,
                    principal_generation, active_token_created_at,
                    provisioning_state
                 ) VALUES (?, ?, ?, ?, 1, ?, 'provisioning')`,
                appId,
                name,
                createdAt,
                principalId,
                createdAt,
            );
        });

        let token: string;
        try {
            token = await issueAccess(this.env, appId, principalId, 1);
            const response = await this.env.LEDGER_APP.getByName(
                appId,
            ).initializeApplication({
                appId,
                name,
                principalId,
                generation: 1,
                createdAt,
                eventPolicy: JSON.stringify(payload.policy ?? NEW_APPLICATION_POLICY),
            });
            if (!response.ok) {
                throw new Error(
                    `application initialization returned ${response.status}`,
                );
            }
        } catch (cause) {
            this.ctx.storage.sql.exec(
                `UPDATE applications SET provisioning_state = 'failed'
                 WHERE id = ?`,
                appId,
            );
            console.error(
                JSON.stringify({
                    message: "Ledger application provisioning failed",
                    appId,
                    error: normalizeError(cause).message,
                }),
            );
            throw new LedgerError(500, {
                error: "application provisioning failed",
                code: "provisioning_failed",
            });
        }
        this.ctx.storage.sql.exec(
            `UPDATE applications SET provisioning_state = 'active'
             WHERE id = ?`,
            appId,
        );
        return rpcSuccess(
            {
                app: {
                    id: appId,
                    name,
                    createdAt,
                    revokedAt: null,
                    activeTokenCreatedAt: createdAt,
                },
                token,
            },
            201,
        );
    }

    private async rotate(
        appId: string,
    ): Promise<RpcSuccess<ApplicationTokenResponse>> {
        const current = this.get(appId);
        if (!current) {
            throw new LedgerError(404, {
                error: "application not found",
                code: "not_found",
            });
        }
        if (
            current.revoked_at !== null ||
            current.provisioning_state !== "active"
        ) {
            throw new LedgerError(409, {
                error: "application is revoked",
                code: "application_revoked",
            });
        }

        const principalId = crypto.randomUUID();
        const generation = current.principal_generation + 1;
        const createdAt = new Date().toISOString();
        // Reserve the generation before awaiting anything, so concurrent
        // rotations get distinct generations. A failed rotation leaves the
        // reservation behind; the application keeps its previous principal
        // and the next rotation still moves forward.
        this.ctx.storage.sql.exec(
            `UPDATE applications
             SET active_principal_id = ?, principal_generation = ?,
                 active_token_created_at = ?
             WHERE id = ?`,
            principalId,
            generation,
            createdAt,
            appId,
        );
        // Sign first: a configuration error must not rotate out the only
        // working credential without returning its replacement.
        const token = await issueAccess(
            this.env,
            appId,
            principalId,
            generation,
        );
        const response = await this.env.LEDGER_APP.getByName(
            appId,
        ).rotateApplicationPrincipal({
            principalId,
            generation,
            createdAt,
        });
        if (!response.ok) {
            throw new LedgerError(500, {
                error: "principal rotation failed",
                code: "rotation_failed",
            });
        }
        return rpcSuccess({
            app: {
                id: appId,
                name: current.name,
                createdAt: current.created_at,
                revokedAt: null,
                activeTokenCreatedAt: createdAt,
            },
            token,
        });
    }

    private async revoke(
        appId: string,
    ): Promise<RpcSuccess<ApplicationSummary>> {
        const current = this.get(appId);
        if (!current) {
            throw new LedgerError(404, {
                error: "application not found",
                code: "not_found",
            });
        }
        const revokedAt = current.revoked_at ?? new Date().toISOString();
        if (current.revoked_at === null) {
            const response = await this.env.LEDGER_APP.getByName(
                appId,
            ).revokeApplicationState({ revokedAt });
            if (!response.ok) {
                throw new LedgerError(500, {
                    error: "application revocation failed",
                    code: "revocation_failed",
                });
            }
            this.ctx.storage.sql.exec(
                "UPDATE applications SET revoked_at = ? WHERE id = ?",
                revokedAt,
                appId,
            );
        }
        return rpcSuccess({
            id: appId,
            name: current.name,
            createdAt: current.created_at,
            revokedAt,
            activeTokenCreatedAt: current.active_token_created_at,
        } satisfies ApplicationSummary);
    }

    private activeApplication(appId: string): ApplicationRow {
        const current = this.get(appId);
        if (!current || current.provisioning_state !== "active" || current.revoked_at !== null) {
            throw new LedgerError(404, { error: "application not found", code: "not_found" });
        }
        return current;
    }

    private get(appId: string): ApplicationRow | undefined {
        return this.ctx.storage.sql
            .exec<ApplicationRow>(
                `SELECT id, name, created_at, revoked_at, active_principal_id,
                        principal_generation, active_token_created_at,
                        provisioning_state
                 FROM applications WHERE id = ?`,
                appId,
            )
            .toArray()[0];
    }
}

function rowSummary(row: ApplicationRow): ApplicationSummary {
    return {
        id: parseUuid(row.id, "stored application id"),
        name: row.name,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
        activeTokenCreatedAt: row.active_token_created_at,
    };
}
