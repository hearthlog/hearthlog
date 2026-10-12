# Ledger Service Client

HTTP client library for the Ledger Service API, which provides entity-level optimistic locking for event storage.

The backend-owned OpenAPI contract is `packages/ledger/docs/event-store-service.openapi.yaml` at the monorepo root.

## Files

| File                 | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `http-client.ts`     | Ledger client, HTTP retry, API errors, and socket URL construction |
| `client.ts`          | Shared configured browser transport                               |
| `admin-client.ts`    | Typed, no-retry Ledger administrator client                        |
| `config.ts`          | Configuration loading and validation                               |
| `types.ts`           | TypeScript interfaces for API contracts                            |
| `entity-id.ts`       | Entity ID extraction from AppEvent                                 |
| `version-tracker.ts` | Entity version tracking in SQLite                                  |
| `socket.ts`          | WebSocket protocol validation, cursors, and reconnect lifecycle    |
| `index.ts`           | Public API exports                                                 |

## Configuration

Configure via environment variables (copy `.env.example` to `.env`):

### Local HTTP connection

- `VITE_LEDGER_SERVICE_URL` - Base URL for Ledger Service API
- Browser builds should not define `VITE_LEDGER_AUTH_TOKEN`; local and
  production gateways inject the Ledger app credential server-side.

Browser realtime uses the same-origin gateway because the browser WebSocket
API cannot attach the app bearer header. The Vite development proxy and the
deployed frontend Worker both inject it during the upgrade.

In a production build both are optional. The client defaults to
`/api/ledger`, where the frontend Cloudflare Worker injects its
`LEDGER_AUTH_TOKEN` secret and forwards requests to the Ledger Worker through a
service binding.

The Developer page's Ledger tab uses `/api/ledger/admin/v1`. It first requests
the verified Access session and does not request application data until that
succeeds. Create, rotate, and revoke calls are attempted once; a network
failure has an unknown outcome and must be reconciled by refreshing the list.
New and rotated credentials are held only in component memory until their
one-time token drawer closes. Application details load log metadata for active
or revoked apps and provide a streamed JSON download containing app metadata,
every log, and every event. Existing bearer keys remain hidden; rotation is
the only operation that reveals a new key.

### Optional

- `VITE_LEDGER_TIMEOUT_MS` - Request timeout (default: 5000ms)
- `VITE_LEDGER_MAX_RETRIES` - Retry attempts (default: 3)
- `VITE_LEDGER_ENABLE_REALTIME` - Enable WebSocket realtime delivery (default: true)

## Usage

```typescript
import { getLedgerClient } from "#lib/ledger/index.js";

const client = getLedgerClient();

// Resolve the stable tenant and credential principal.
const session = await client.getSession();

// List logs
const logs = await client.listLogs();

// Get events
const events = await client.getEvents(logId);

// Open realtime delivery after HTTP synchronization.
const socket = client.createEventSocket(logId, events.at(-1)?.version ?? 0);
socket.on("event", async (storedEvent) => {
  // Persist first; acknowledge only after the local transaction commits.
  socket.acknowledge(storedEvent.version);
});
await socket.open();

// Append a prepared idempotent batch.
await client.appendEvents(logId, request);
```

Use `getLedgerClient()` for the app's default transport so bootstrap, sync, and log
consumers reuse negotiated capabilities. Concurrent `getSession()` calls share
only their pending request; the request is cleared on success or failure, and
later explicit session reads still verify online. Capability getters keep their
existing per-client cache. Use `new LedgerClient(config)` for a separately
configured transport; its verification and capabilities stay isolated.

## Retry Policy

Default exponential backoff:

- Initial delay: 1s
- Maximum delay: 10s
- Multiplier: 2x
- Max retries: 3

Delays: 1s → 2s → 4s before failing.

## Error Handling

| Error Class                | HTTP Status | When                                           |
| -------------------------- | ----------- | ---------------------------------------------- |
| `VersionConflictError`     | 409         | First base is stale for an existing entity     |
| `EntityVersionChainError`  | 409         | Later bases do not form a valid batch chain    |
| `IdempotencyMismatchError` | 409         | A request ID was reused with different content |
| `NotFoundError`            | 404         | Resource not found                             |
| `AuthenticationError`      | 401/403     | Auth failed                                    |
| `LedgerServiceError`       | Other       | General API errors                             |

## Development

For local development, run `pnpm ledger:dev` and then `pnpm dev` from the
repository root. The browser keeps using `/api/ledger`; Vite provisions a
local app credential and proxies both HTTP and `ledger.v1` WebSockets to the
Worker on `http://127.0.0.1:8787`.
