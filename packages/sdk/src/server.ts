export { DurableObject } from 'cloudflare:workers';

/**
 * Module API v0 for gateway Worker code: Access authorization, Ledger scope
 * verification, and request bodies. A module's server entry imports only this
 * (plus its own files); the host keeps the Ledger proxy, session, and admin.
 */
export {
    authorizeStorRequest,
    LedgerAdminAuthorizationError,
    LedgerAdminConfigurationError,
    type LedgerAdminIdentity,
    type StorAuthEnv,
} from '@hearthlog/cloudflare/access-auth.js';
export { isUuid, LedgerScopeError, verifyLogAppId, type LedgerScopeEnv } from '@hearthlog/cloudflare/ledger-scope.js';
export { readBodyCapped } from '@hearthlog/cloudflare/request-body.js';
export { readLedgerCheckpoint } from '@hearthlog/cloudflare/checkpoint-reader.js';
export type {
    DevServerContext, DevServerModule, EmailHandler, EmailRequest, FileContributor, ForkFile, ForkHistoryEvent, InboundEmail, IntegrationHandler,
    IntegrationRequest, ServerIntegration, ServerJobContext, ServerModule, ServiceAppend, ServiceEvent,
} from '@hearthlog/contracts';
export { GATEWAY_CRONS, MAX_INBOUND_EMAIL_BYTES } from '@hearthlog/contracts';
export { serverIntegrationsFor } from '@hearthlog/cloudflare/integrations/server.js';
export { deterministicUuid } from '@hearthlog/contracts/integrations/ids';
export { IntegrationRequestError } from '@hearthlog/contracts/integrations/service';

// Shared accepted-history semantics for module-owned private file references.
export { selectReplayEvents, type ReplayEvent } from "@hearthlog/contracts/history/replay-selection";
