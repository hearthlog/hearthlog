import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ledgerDevVars, parseDevVars } from './dev-ledger.js';

test("a new site's local Ledger secrets are random, long enough to sign tokens, and read back as written", () => {
    const first = parseDevVars(ledgerDevVars());
    const second = parseDevVars(ledgerDevVars());
    assert.notEqual(first.ADMIN_TOKEN, second.ADMIN_TOKEN);
    // The Ledger refuses a signing key shorter than 32 bytes.
    assert.ok(new TextEncoder().encode(first.TOKEN_SIGNING_KEY_CURRENT).byteLength >= 32);
    assert.deepEqual(Object.keys(first).sort(), ['ADMIN_TOKEN', 'ALLOWED_ORIGINS', 'TOKEN_SIGNING_KEY_CURRENT']);
});

test('a .dev.vars file skips comments and blank lines and unquotes its values', () => {
    assert.deepEqual(parseDevVars('# local\n\nADMIN_TOKEN = "abc"\nOTHER=\'x y\'\n#IGNORED=1\n'), { ADMIN_TOKEN: 'abc', OTHER: 'x y' });
});
