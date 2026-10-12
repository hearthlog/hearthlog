import assert from 'node:assert/strict';
import { test } from 'node:test';

import { identityMapping, isOwnerRecord, planFileCopies, rewriteOwner, type TenantCopyMapping } from './tenant-copy-plan.js';

const SOURCE_APP = '11111111-1111-4111-8111-111111111111';
const TARGET_APP = '22222222-2222-4222-8222-222222222222';
const SOURCE_LOG = '33333333-3333-4333-8333-333333333333';
const TARGET_LOG = '44444444-4444-4444-8444-444444444444';
const PUBLICATION = '55555555-5555-4555-8555-555555555555';
const mapping: TenantCopyMapping = { sourceAppId: SOURCE_APP, targetAppId: TARGET_APP, logs: { [SOURCE_LOG]: TARGET_LOG } };

test('maps every private key prefix to the new app and log', () => {
    const jobs = planFileCopies(mapping, [PUBLICATION]);
    assert.deepEqual(jobs.filter((job) => job.pair === 'invoice-pdfs').map((job) => [job.fromPrefix, job.toPrefix]), [
        [`received/v1/${SOURCE_APP}/${SOURCE_LOG}/`, `received/v1/${TARGET_APP}/${TARGET_LOG}/`],
        [`received-isdoc/v1/${SOURCE_APP}/${SOURCE_LOG}/`, `received-isdoc/v1/${TARGET_APP}/${TARGET_LOG}/`],
        [`issued/v1/${SOURCE_APP}/${SOURCE_LOG}/`, `issued/v1/${TARGET_APP}/${TARGET_LOG}/`],
        [`issued-isdoc/v1/${SOURCE_APP}/${SOURCE_LOG}/`, `issued-isdoc/v1/${TARGET_APP}/${TARGET_LOG}/`],
    ]);
    assert.ok(jobs.some((job) => job.pair === 'gallery-files' && job.fromPrefix === `v1/${SOURCE_APP}/` && job.toPrefix === `v1/${TARGET_APP}/`));
    assert.ok(jobs.some((job) => job.pair === 'gallery-files' && job.fromPrefix === `v1/publications/${PUBLICATION}/` && job.rewriteOwner));
    assert.ok(jobs.some((job) => job.pair === 'gallery-public' && job.fromPrefix === `v1/galleries/${PUBLICATION}/`));
    // The generated-invoice cache rebuilds on demand and is never copied.
    assert.ok(!jobs.some((job) => job.pair === 'invoice-pdfs' && job.fromPrefix.startsWith('v1/')));
});

test('rewrites a publication owner to the copied log and refuses anything else', () => {
    assert.deepEqual(rewriteOwner({ appId: SOURCE_APP, logId: SOURCE_LOG }, mapping), { appId: TARGET_APP, logId: TARGET_LOG });
    assert.throws(() => rewriteOwner({ appId: TARGET_APP, logId: SOURCE_LOG }, mapping), /another app/);
    assert.throws(() => rewriteOwner({ appId: SOURCE_APP, logId: TARGET_LOG }, mapping), /not copied/);
    assert.ok(isOwnerRecord(`v1/publications/${PUBLICATION}/owner.json`));
    assert.ok(!isOwnerRecord(`v1/publications/${PUBLICATION}/revisions/r/draft.json`));
});

test('rejects a mapping that would copy into the same app', () => {
    assert.throws(() => planFileCopies({ ...mapping, targetAppId: SOURCE_APP }, []), /same/);
});

test('an identity move copies every prefix to the same name, per app, and leaves owner records alone', () => {
    const jobs = planFileCopies(identityMapping(SOURCE_APP), [PUBLICATION]);
    assert.ok(jobs.every((job) => job.fromPrefix === job.toPrefix), 'keys do not change');
    assert.ok(jobs.every((job) => !job.rewriteOwner), 'the owner records already name the right app and log');
    assert.deepEqual(jobs.filter((job) => job.pair === 'invoice-pdfs').map((job) => job.fromPrefix), [
        `received/v1/${SOURCE_APP}/`, `received-isdoc/v1/${SOURCE_APP}/`, `issued/v1/${SOURCE_APP}/`, `issued-isdoc/v1/${SOURCE_APP}/`,
    ]);
    assert.ok(jobs.some((job) => job.pair === 'gallery-files' && job.fromPrefix === `v1/${SOURCE_APP}/`));
    assert.ok(jobs.some((job) => job.pair === 'gallery-files' && job.fromPrefix === `v1/publications/${PUBLICATION}/`));
    assert.ok(jobs.some((job) => job.pair === 'gallery-public' && job.fromPrefix === `v1/galleries/${PUBLICATION}/`));
    assert.ok(!jobs.some((job) => job.pair === 'invoice-pdfs' && job.fromPrefix.startsWith('v1/')), 'the PDF cache still rebuilds');
});

test('an identity move refuses a different app or a log mapping', () => {
    assert.throws(() => planFileCopies({ ...identityMapping(SOURCE_APP), targetAppId: TARGET_APP }, []), /same id/);
    assert.throws(() => planFileCopies({ ...identityMapping(SOURCE_APP), logs: { [SOURCE_LOG]: TARGET_LOG } }, []), /names no logs/);
});
