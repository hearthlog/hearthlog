import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { auditHistory } from './audit-push.js';

test('accepts GitHub bot noreply authors while rejecting a lookalike email domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'hearthlog-push-audit-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    const bot = '41898282+github-actions[bot]@users.noreply.github.com';
    const list = { path: 'fixture', forbidden: [], allowedAuthorEmails: ['fixture@example.test'] };
    try {
        git('init', '--quiet');
        git('config', 'user.name', 'Fixture');
        git('config', 'user.email', 'fixture@example.test');
        const commit = (email: string) => execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture'], {
            cwd: root,
            stdio: 'pipe',
            env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: email },
        });
        commit(bot);
        assert.deepEqual(auditHistory(root, list), []);
        commit(`${bot}.example.test`);
        assert.deepEqual(auditHistory(root, list).map(({ kind }) => kind).sort(), ['author-not-allowed', 'committer-not-allowed']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
