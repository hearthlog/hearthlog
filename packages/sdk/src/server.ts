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
export type {
    FileContributor, ForkFile, ForkHistoryEvent, IntegrationHandler, IntegrationRequest, ServerModule, ServiceAppend, ServiceEvent,
} from '@hearthlog/contracts';
export { deterministicUuid } from '@hearthlog/contracts/integrations/ids';
export { IntegrationRequestError } from '@hearthlog/contracts/integrations/service';
