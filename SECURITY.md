# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue. Use the repository's
"Report a vulnerability" form (GitHub private vulnerability reporting). Include what you saw,
how to reproduce it, and which release or commit.

You can expect an acknowledgement within a few days. We fix confirmed issues on the supported
release train and credit reporters who want it.

## What is in scope

- The platform packages and first-party modules in this repository.
- The gateway Worker, the Ledger, and the tooling that provisions them.

Modules run with the privileges of application code (same origin, storage, and the gateway's
bindings); there is no sandbox between modules of one tenant. Review a module before installing it.

## Not in scope

- Issues that need a tenant's own credentials or administrator access.
- Your deployment's configuration (Cloudflare Access policies, tokens, account settings).
