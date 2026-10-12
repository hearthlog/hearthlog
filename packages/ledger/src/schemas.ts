import { t } from "elysia";
import type {
    AdminConnection as AdminConnectionContract,
    AdminConnectionsResponse as AdminConnectionsResponseContract,
    AdminRecentConnection as AdminRecentConnectionContract,
} from "@hearthlog/contracts/ledger/admin";

type JsonPrimitive = null | boolean | number | string;
// A bounded depth keeps Cloudflare's RPC serializability inference finite.
type JsonValue0 = JsonPrimitive;
type JsonValue1 = JsonPrimitive | JsonValue0[] | Record<string, JsonValue0>;
type JsonValue2 = JsonPrimitive | JsonValue1[] | Record<string, JsonValue1>;
type JsonValue3 = JsonPrimitive | JsonValue2[] | Record<string, JsonValue2>;
type JsonValue4 = JsonPrimitive | JsonValue3[] | Record<string, JsonValue3>;
type JsonValue5 = JsonPrimitive | JsonValue4[] | Record<string, JsonValue4>;
type JsonValue6 = JsonPrimitive | JsonValue5[] | Record<string, JsonValue5>;

export type JsonValue = JsonValue6;
export type JsonObject = Record<string, JsonValue>;

const uuid = (label: string) =>
    t.String({
        format: "uuid",
        error: `${label} must be a UUID`,
    });

const jsonObject = t.Unsafe<JsonObject>(t.Record(t.String(), t.Unknown()));

const strictObject = { additionalProperties: false } as const;
const queryInteger = {
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    multipleOf: 1,
} as const;
const queryLimit = {
    ...queryInteger,
    minimum: 1,
} as const;

/** What an application may append; see `EventPolicy` in event-validation.ts. */
export const eventPolicyBody = t.Object(
    {
        contracts: t.Union([t.Array(t.String({ pattern: "^(core|[a-z0-9]+(\\.[a-z0-9-]+)+)$" }), { maxItems: 64 }), t.Null()]),
        dynamicEvents: t.Boolean(),
        validation: t.Union([t.Literal("report"), t.Literal("enforce"), t.Null()]),
    },
    strictObject,
);

export const importBeginBody = t.Object(
    {
        id: uuid("application id"),
        name: t.String(),
        createdAt: t.String(),
        policy: t.Optional(t.Union([eventPolicyBody, t.Null()])),
    },
    strictObject,
);

/** Records are validated strictly by `parseTransferRecords`, not by the route. */
export const importRecordsBody = t.Object({ records: t.Array(t.Any(), { minItems: 1, maxItems: 2000 }) }, strictObject);

export const importFinishBody = t.Object(
    { logs: t.Array(t.Object({ id: uuid("log id"), headVersion: t.Integer({ minimum: 0 }) }, strictObject), { maxItems: 10000 }) },
    strictObject,
);

export const fenceBody = t.Object(
    {
        mode: t.Union([t.Literal("off"), t.Literal("tenant_migrating"), t.Literal("moved")]),
        destination: t.Optional(t.Nullable(t.String())),
    },
    strictObject,
);

export const createApplicationBody = t.Object(
    {
        name: t.String(),
        /** Omitted: the application starts with the policy new applications get. */
        policy: t.Optional(eventPolicyBody),
    },
    strictObject,
);

export const applicationParams = t.Object(
    {
        appId: uuid("application id"),
    },
    strictObject,
);

export const createLogBody = t.Object(
    {
        name: t.Optional(t.Nullable(t.String())),
    },
    strictObject,
);

export const logVisibilityBody = t.Object(
    {
        hidden: t.Boolean(),
    },
    strictObject,
);

export const forkLogBody = t.Object(
    {
        name: t.String({ minLength: 1 }),
        targetVersion: t.Integer(queryInteger),
        expectedSourceHeadVersion: t.Integer(queryInteger),
        requestId: uuid('fork request id'),
    },
    strictObject,
);

export const logLineageBody = t.Object(
    {
        sourceLogId: uuid('source log id'),
        sourceVersion: t.Integer(queryInteger),
    },
    strictObject,
);

export const logParams = t.Object(
    {
        logId: uuid("logId"),
    },
    strictObject,
);

export const galleryPhotoReferenceParams = t.Object(
    {
        logId: uuid('log id'),
        photoId: uuid('gallery photo id'),
        fileVersionId: uuid('gallery file version id'),
    },
    strictObject,
);

export const eventsQuery = t.Object(
    {
        afterVersion: t.Optional(t.Numeric(queryInteger)),
        limit: t.Optional(t.Numeric(queryLimit)),
    },
    strictObject,
);

export const socketQuery = t.Object(
    {
        replayVersion: t.Optional(t.Numeric(queryInteger)),
        afterVersion: t.Optional(t.Numeric(queryInteger)),
    },
    strictObject,
);

export const adminEventParams = t.Object(
    {
        appId: uuid("application id"),
        logId: uuid("log id"),
    },
    strictObject,
);

export const adminEventsQuery = t.Object(
    {
        beforeVersion: t.Optional(t.Numeric({ ...queryInteger, minimum: 1 })),
        limit: t.Optional(t.Numeric({ ...queryLimit, maximum: 100 })),
        search: t.Optional(t.String({ maxLength: 200 })),
    },
    strictObject,
);

export const adminMetrics = t.Object(
    {
        sampledAt: t.String(),
        logCount: t.Integer({ minimum: 0 }),
        eventCount: t.Integer({ minimum: 0 }),
        entityCount: t.Integer({ minimum: 0 }),
        databaseBytes: t.Integer({ minimum: 0 }),
        connectedClients: t.Integer({ minimum: 0 }),
        lastUpdatedAt: t.Nullable(t.String()),
    },
    strictObject,
);

export const adminConnectionsQuery = t.Object(
    { afterId: t.Optional(uuid("connection id")) },
    strictObject,
);
const adminConnectionClient = t.Object(
    {
        userAgent: t.Nullable(t.String()),
        ip: t.Nullable(t.String()),
        country: t.Nullable(t.String()),
        colo: t.Nullable(t.String()),
    },
    strictObject,
);
export const adminConnection = t.Object(
    {
        id: uuid("connection id"),
        logId: uuid("log id"),
        logName: t.Nullable(t.String()),
        principalId: uuid("principal id"),
        generation: t.Integer({ minimum: 1 }),
        state: t.Union([
            t.Literal("connecting"),
            t.Literal("open"),
            t.Literal("closing"),
            t.Literal("closed"),
        ]),
        cursor: t.Integer({ minimum: 0 }),
        headVersion: t.Nullable(t.Integer({ minimum: 0 })),
        connectedAt: t.Nullable(t.String()),
        lastSentAt: t.Nullable(t.String()),
        client: adminConnectionClient,
    },
    strictObject,
);
export const adminRecentConnection = t.Object(
    {
        id: uuid("connection id"),
        logId: uuid("log id"),
        logName: t.Nullable(t.String()),
        principalId: uuid("principal id"),
        generation: t.Integer({ minimum: 1 }),
        cursor: t.Integer({ minimum: 0 }),
        connectedAt: t.String(),
        disconnectedAt: t.Nullable(t.String()),
        closeCode: t.Nullable(t.Integer({ minimum: 0 })),
        lastSentAt: t.Nullable(t.String()),
        client: adminConnectionClient,
    },
    strictObject,
);
export const adminConnectionsResponse = t.Object(
    {
        sampledAt: t.String(),
        total: t.Integer({ minimum: 0 }),
        unavailable: t.Integer({ minimum: 0 }),
        connections: t.Array(adminConnection),
        nextAfterId: t.Nullable(uuid("connection id")),
        recent: t.Array(adminRecentConnection),
    },
    strictObject,
);

export const incomingEvent = t.Object(
    {
        id: t.Optional(t.Nullable(uuid("event id"))),
        type: t.String(),
        timestamp: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
        entityId: t.String(),
        baseEntityVersion: t.Optional(t.Nullable(t.Integer({ minimum: 0 }))),
        payload: jsonObject,
    },
    strictObject,
);

export const appendEventsBody = t.Object(
    {
        requestId: uuid("requestId"),
        actionId: t.Optional(uuid("actionId")),
        expectedLogVersion: t.Optional(t.Integer({ minimum: 0 })),
        events: t.Array(incomingEvent, { maxItems: 512 }),
    },
    strictObject,
);

export const storedEvent = t.Object(
    {
        action: t.Optional(t.Object({
            id: uuid("action id"),
            index: t.Integer({ minimum: 0 }),
            size: t.Integer({ minimum: 1 }),
        }, strictObject)),
        version: t.Integer({ minimum: 1 }),
        id: uuid("stored event id"),
        type: t.String(),
        entityId: t.String(),
        entityVersion: t.Integer({ minimum: 1 }),
        timestamp: t.Integer({ minimum: 0 }),
        payload: jsonObject,
        /** Identity the gateway verified for the request that wrote the event. */
        actor: t.Optional(t.String({ minLength: 1, maxLength: 320 })),
    },
    strictObject,
);

export const logSummary = t.Object(
    {
        id: uuid("stored log id"),
        name: t.String(),
        headVersion: t.Integer({ minimum: 0 }),
        createdAt: t.String(),
        lastUpdatedAt: t.Nullable(t.String()),
        sourceLogId: t.Nullable(uuid('source log id')),
        sourceLogName: t.Nullable(t.String()),
        sourceVersion: t.Nullable(t.Integer({ minimum: 0 })),
        sourceTimestamp: t.Nullable(t.String()),
        status: t.Union([t.Literal('ready'), t.Literal('preparing')]),
        hiddenAt: t.Nullable(t.String()),
    },
    strictObject,
);

export const applicationSummary = t.Object(
    {
        id: uuid("stored application id"),
        name: t.String(),
        createdAt: t.String(),
        revokedAt: t.Nullable(t.String()),
        activeTokenCreatedAt: t.Nullable(t.String()),
    },
    strictObject,
);

export const apiModels = {
    AdminConnectionsResponse: adminConnectionsResponse,
    AdminMetricsResponse: adminMetrics,
    AdminEventsResponse: t.Object(
        {
            events: t.Array(storedEvent),
            headVersion: t.Integer({ minimum: 0 }),
            nextBeforeVersion: t.Nullable(t.Integer({ minimum: 1 })),
        },
        strictObject,
    ),
    ApplicationResponse: applicationSummary,
    ApplicationListResponse: t.Object(
        {
            apps: t.Array(applicationSummary),
        },
        strictObject,
    ),
    ApplicationTokenResponse: t.Object(
        {
            app: applicationSummary,
            token: t.String(),
        },
        strictObject,
    ),
    AppendEventsResponse: t.Object(
        {
            newVersion: t.Integer({ minimum: 0 }),
            events: t.Array(storedEvent),
        },
        strictObject,
    ),
    CreateLogResponse: t.Object(
        {
            id: uuid("stored log id"),
            name: t.String(),
            headVersion: t.Literal(0),
            createdAt: t.String(),
        },
        strictObject,
    ),
    EmptyResponse: t.Null(),
    EventBatchResponse: t.Object(
        {
            events: t.Array(storedEvent),
        },
        strictObject,
    ),
    HealthResponse: t.Null(),
    LogListResponse: t.Object(
        {
            logs: t.Array(logSummary),
            lineage: t.Object({
                rootIds: t.Array(uuid('root log id')),
                childIdsByLogId: t.Record(t.String(), t.Array(uuid('child log id'))),
            }, strictObject),
        },
        strictObject,
    ),
    LogResponse: logSummary,
    ForkLogResponse: logSummary,
    GalleryPhotoReferenceResponse: t.Object({ present: t.Boolean() }, strictObject),
    SessionResponse: t.Object(
        {
            appId: uuid("appId"),
            principalId: uuid("principalId"),
            capabilities: t.Optional(t.Array(t.String())),
            fence: t.Optional(t.Object({
                mode: t.Union([t.Literal("tenant_migrating"), t.Literal("moved")]),
                destination: t.Nullable(t.String()),
            }, strictObject)),
        },
        strictObject,
    ),
};

export type CreateApplicationRequest = typeof createApplicationBody.static;
export type EventPolicyRequest = typeof eventPolicyBody.static;
export type CreateLogRequest = typeof createLogBody.static;
export type ForkLogRequest = typeof forkLogBody.static;
export type LogVisibilityRequest = typeof logVisibilityBody.static;
export type EventsQuery = typeof eventsQuery.static;
export type IncomingEvent = typeof incomingEvent.static;
export type AppendEventsRequest = typeof appendEventsBody.static;
export type StoredEvent = typeof storedEvent.static;
export type ApplicationSummary = typeof applicationSummary.static;
export type ApplicationListResponse =
    typeof apiModels.ApplicationListResponse.static;
export type ApplicationTokenResponse =
    typeof apiModels.ApplicationTokenResponse.static;
export type AppendEventsResponse = typeof apiModels.AppendEventsResponse.static;
export type CreateLogResponse = typeof apiModels.CreateLogResponse.static;
export type EventBatchResponse = typeof apiModels.EventBatchResponse.static;
export type LogSummary = typeof logSummary.static;
export type LogListResponse = typeof apiModels.LogListResponse.static;
export type SessionResponse = typeof apiModels.SessionResponse.static;
export type AdminMetrics = typeof adminMetrics.static;
export type AdminEventsQuery = typeof adminEventsQuery.static;
export type AdminEventsResponse = typeof apiModels.AdminEventsResponse.static;
export type AdminConnection = typeof adminConnection.static;
export type AdminRecentConnection = typeof adminRecentConnection.static;
export type AdminConnectionsQuery = typeof adminConnectionsQuery.static;
export type AdminConnectionsResponse = typeof adminConnectionsResponse.static;

// The browser's view of these responses is `@hearthlog/contracts/ledger/admin`; this fails to
// compile when the schemas and those types stop describing the same shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const adminContractsMatch: [
    Same<AdminConnection, AdminConnectionContract>,
    Same<AdminRecentConnection, AdminRecentConnectionContract>,
    Same<AdminConnectionsResponse, AdminConnectionsResponseContract>,
] = [true, true, true];
