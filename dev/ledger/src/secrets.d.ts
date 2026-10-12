interface LedgerOptionalSecrets {
    TOKEN_SIGNING_KEY_PREVIOUS?: string;
}

interface Env extends LedgerOptionalSecrets {}

declare namespace Cloudflare {
    interface Env extends LedgerOptionalSecrets {}
}
