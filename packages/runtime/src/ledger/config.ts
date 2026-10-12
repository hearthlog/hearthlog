/**
 * Configuration for the Ledger Service client
 */

export interface RetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export interface LedgerConfig {
  baseUrl: string;
  authToken?: string;
  timeout: number;
  retryPolicy: RetryPolicy;
  enableRealtime: boolean;
}

/**
 * Default retry policy with exponential backoff
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2
};

/**
 * Validation error thrown when configuration is invalid
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates the Ledger Service configuration
 * @throws {ConfigValidationError} if configuration is invalid
 */
function validateConfig(config: Partial<LedgerConfig>): void {
  if (!config.baseUrl) {
    throw new ConfigValidationError('LEDGER_SERVICE_URL is required');
  }

  const isRelative =
    config.baseUrl.startsWith('/') && !config.baseUrl.startsWith('//');
  let isAbsoluteHttp = false;
  if (!isRelative) {
    try {
      const parsed = new URL(config.baseUrl);
      isAbsoluteHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      isAbsoluteHttp = false;
    }
  }
  if (!isRelative && !isAbsoluteHttp) {
    throw new ConfigValidationError(`Invalid LEDGER_SERVICE_URL: ${config.baseUrl}`);
  }

  if (config.timeout !== undefined && (config.timeout <= 0 || !Number.isFinite(config.timeout))) {
    throw new ConfigValidationError(`Invalid timeout value: ${config.timeout}`);
  }

  if (config.retryPolicy) {
    const { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier } = config.retryPolicy;
    
    if (maxRetries < 0 || !Number.isInteger(maxRetries)) {
      throw new ConfigValidationError(`Invalid maxRetries: ${maxRetries}`);
    }
    
    if (initialDelayMs <= 0 || !Number.isFinite(initialDelayMs)) {
      throw new ConfigValidationError(`Invalid initialDelayMs: ${initialDelayMs}`);
    }
    
    if (maxDelayMs <= 0 || !Number.isFinite(maxDelayMs)) {
      throw new ConfigValidationError(`Invalid maxDelayMs: ${maxDelayMs}`);
    }
    
    if (backoffMultiplier <= 1 || !Number.isFinite(backoffMultiplier)) {
      throw new ConfigValidationError(`Invalid backoffMultiplier: ${backoffMultiplier}`);
    }
  }
}

/**
 * Loads and validates Ledger Service configuration from environment variables
 * @returns {LedgerConfig} Validated configuration object
 * @throws {ConfigValidationError} if configuration is invalid or missing required values
 */
export function loadLedgerConfig(): LedgerConfig {
  const baseUrl = import.meta.env.VITE_LEDGER_SERVICE_URL;
  const authToken = import.meta.env.VITE_LEDGER_AUTH_TOKEN;
  const timeoutStr = import.meta.env.VITE_LEDGER_TIMEOUT_MS;
  const maxRetriesStr = import.meta.env.VITE_LEDGER_MAX_RETRIES;
  const enableRealtimeStr = import.meta.env.VITE_LEDGER_ENABLE_REALTIME;

  const config: LedgerConfig = {
    baseUrl: baseUrl || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '/api/ledger'),
    authToken: authToken || undefined,
    timeout: timeoutStr ? parseInt(timeoutStr, 10) : 5000,
    retryPolicy: {
      maxRetries: maxRetriesStr ? parseInt(maxRetriesStr, 10) : DEFAULT_RETRY_POLICY.maxRetries,
      initialDelayMs: DEFAULT_RETRY_POLICY.initialDelayMs,
      maxDelayMs: DEFAULT_RETRY_POLICY.maxDelayMs,
      backoffMultiplier: DEFAULT_RETRY_POLICY.backoffMultiplier
    },
    enableRealtime: enableRealtimeStr !== 'false'
  };

  validateConfig(config);

  return config;
}
