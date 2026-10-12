/** Module API v0 for server tests (Worker-safe, run under Vitest in Node): the gateway's handlers, which take the module table to exercise. */
export { handleAiDecisionsRequest, type AiDecisionsEnv } from '@hearthlog/cloudflare/ai-decisions.js';
export { readChoice } from '@hearthlog/cloudflare/ai/decision-model.js';
export { handleIntegrationRequest, type IntegrationsEnv } from '@hearthlog/cloudflare/integrations/index.js';
