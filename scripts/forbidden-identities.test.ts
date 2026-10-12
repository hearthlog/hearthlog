import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { auditBytes, auditFileName, auditText, operatorContext, type AuditContext, type Policy } from './audit-personal-data.js';
import { auditFiles, auditHistory, auditPush } from '../packages/tooling/src/security/audit-push.js';
import { candidateEntries } from '../packages/tooling/src/security/forbidden-init.js';
import { forbiddenIn, forbiddenInBytes, forbiddenListPath, loadForbiddenList, maskForbidden, parseForbiddenList } from '../packages/tooling/src/security/forbidden-identities.js';

// Synthetic values, assembled from parts so this file holds nothing real.
const WORD = `zq${'blorp'}`;
const COMPANY = `${WORD}corp`;
const BAD_MAIL = `jo@${COMPANY}.invalid`;
const OK_MAIL = `me@mailbox.${'invalid'}`;
const path = '/nowhere/forbidden.json';
const list = parseForbiddenList(JSON.stringify({ forbidden: [BAD_MAIL, COMPANY], allowedAuthorEmails: [OK_MAIL] }), path);

function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'hearthlog-forbidden-'));
}

function git(directory: string, args: string[], env: Record<string, string> = {}): string {
    return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}

function commit(directory: string, file: string, content: string, email: string): void {
    writeFileSync(join(directory, file), content);
    git(directory, ['add', '-A']);
    git(directory, ['commit', '-q', '-m', 'change'], {
        GIT_AUTHOR_NAME: 'A',
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: 'A',
        GIT_COMMITTER_EMAIL: email,
    });
}

function repository(): string {
    const directory = scratch();
    git(directory, ['init', '-q', '-b', 'main']);
    git(directory, ['config', 'user.email', OK_MAIL]);
    return directory;
}

test('the list is validated, and no error repeats a value from it', () => {
    assert.deepEqual(list.forbidden, [BAD_MAIL, COMPANY]);
    assert.throws(() => parseForbiddenList('not json', path), /not valid JSON/);
    assert.throws(() => parseForbiddenList('[]', path), /JSON object/);
    assert.throws(() => parseForbiddenList('{"forbidden":[]}', path), /at least one/);
    assert.throws(() => parseForbiddenList('{"forbidden":["abc"]}', path), /entry #1/);
    assert.throws(() => parseForbiddenList(JSON.stringify({ forbidden: [COMPANY], allowedAuthorEmails: ['nobody'] }), path), (error: Error) => {
        assert.match(error.message, /entry #1/);
        assert.ok(!error.message.includes(COMPANY) && !error.message.includes('nobody'));
        return true;
    });
});

test('the audit and the snapshot refuse to run without the file', async () => {
    const directory = scratch();
    const previous = process.env.HEARTHLOG_FORBIDDEN_FILE;
    process.env.HEARTHLOG_FORBIDDEN_FILE = join(directory, 'missing.json');
    try {
        assert.equal(forbiddenListPath(), join(directory, 'missing.json'));
        assert.throws(() => loadForbiddenList(), /audit:forbidden:init/);
        await assert.rejects(() => operatorContext({ operatorPaths: [], redactedPaths: [], placeholderDomains: [], placeholderHosts: [], reviewByEye: [] }), /does not exist/);
    } finally {
        if (previous === undefined) delete process.env.HEARTHLOG_FORBIDDEN_FILE;
        else process.env.HEARTHLOG_FORBIDDEN_FILE = previous;
        rmSync(directory, { recursive: true });
    }
});

test('forbidden values are found case-insensitively in text, names, and bytes, and findings name an entry, not the value', () => {
    assert.deepEqual(forbiddenIn(`written by ${COMPANY.toUpperCase()}`, list.forbidden), [2]);
    assert.deepEqual(forbiddenInBytes(Buffer.from(`\x00\x01${BAD_MAIL}\x02`, 'latin1'), list.forbidden), [1, 2]);
    const policy: Policy = { operatorPaths: [], redactedPaths: [], placeholderDomains: ['example.com'], placeholderHosts: [], reviewByEye: [] };
    const context: AuditContext = { policy, needles: [], redactions: [], forbidden: list.forbidden };
    const findings = [
        ...auditText('a.md', `see ${COMPANY}`, context),
        ...auditFileName(`${COMPANY}/readme.md`, context),
        ...auditBytes('logo.png', Buffer.from(COMPANY), context),
    ];
    assert.deepEqual(findings.map((finding) => finding.kind), ['forbidden', 'forbidden-name', 'forbidden-binary']);
    assert.ok(findings.every((finding) => /^forbidden entry #\d+$/.test(finding.value) && !JSON.stringify(finding).includes(COMPANY)));
    assert.deepEqual(auditText('b.md', 'nothing here', context), []);
});

test('forbidden values in a displayed path are masked, longest entry first', () => {
    assert.equal(maskForbidden(`docs/${BAD_MAIL}/${COMPANY.toUpperCase()}.md`, list.forbidden), 'docs/<forbidden #1>/<forbidden #2>.md');
});

test('the starter list takes history identities, skips the personal address, bots and free mail domains', () => {
    const result = candidateEntries(
        [
            { name: 'A', email: OK_MAIL },
            { name: 'A', email: BAD_MAIL },
            { name: 'A', email: `x@gmail.${'com'}` },
            { name: 'Tool', email: 'noreply@tool.example.com' },
            { name: 'bot[bot]', email: `1+bot@${'users.noreply.'}${'github.com'}` },
        ],
        OK_MAIL,
    );
    assert.deepEqual([...result.entries].sort(), [BAD_MAIL, `x@gmail.${'com'}`, COMPANY].sort());
    assert.deepEqual([result.addresses, result.names], [2, 1]);
});

test('the push gate scans files, names, and binary content', () => {
    const directory = scratch();
    try {
        writeFileSync(join(directory, 'clean.md'), 'nothing');
        mkdirSync(join(directory, 'assets'));
        writeFileSync(join(directory, 'assets', 'logo.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(COMPANY)]));
        writeFileSync(join(directory, `${WORD}corp-notes.md`), 'x');
        const findings = auditFiles(directory, list);
        assert.deepEqual(findings.map((finding) => finding.kind).sort(), ['content', 'file-name']);
        assert.ok(!JSON.stringify(findings).includes(COMPANY));
    } finally {
        rmSync(directory, { recursive: true });
    }
});

test('the push gate checks authors, committers, messages, refs, history diffs, and the repository identity', () => {
    const directory = repository();
    try {
        commit(directory, 'a.txt', 'fine', OK_MAIL);
        assert.deepEqual(auditPush(directory, list), []);

        commit(directory, 'b.txt', 'fine', BAD_MAIL);
        assert.deepEqual(
            auditHistory(directory, list).map((finding) => finding.kind).sort(),
            ['author-not-allowed', 'commit-metadata', 'commit-metadata', 'committer-not-allowed'],
        );
    } finally {
        rmSync(directory, { recursive: true });
    }
});

test('a value committed and then deleted still fails the gate, and so does a wrong repository identity', () => {
    const directory = repository();
    try {
        commit(directory, 'a.txt', `contains ${COMPANY}`, OK_MAIL);
        commit(directory, 'a.txt', 'clean now', OK_MAIL);
        assert.deepEqual(auditFiles(directory, list), []);
        assert.deepEqual(auditHistory(directory, list).map((finding) => finding.kind), ['history-content']);
        git(directory, ['config', 'user.email', BAD_MAIL]);
        assert.ok(auditHistory(directory, list).some((finding) => finding.kind === 'identity-not-allowed'));
        assert.ok(!JSON.stringify(auditHistory(directory, list)).includes(COMPANY));
    } finally {
        rmSync(directory, { recursive: true });
    }
});

test('the gate needs at least one allowed author address', () => {
    const open = parseForbiddenList(JSON.stringify({ forbidden: [COMPANY] }), path);
    const directory = scratch();
    try {
        assert.deepEqual(auditPush(directory, open).map((finding) => finding.kind), ['no-allowed-authors']);
    } finally {
        rmSync(directory, { recursive: true });
    }
});
