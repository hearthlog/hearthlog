import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    ApplyError,
    newReceipt,
    parseReceipt,
    planDeployment,
    renderPlan,
    runApply,
    serializeReceipt,
    type PlanInput,
    type StepExecutor,
    type StepId,
    type TenantResources,
} from './index.js';

const resources = (prefix: string): TenantResources => ({
    ledgerWorker: `${prefix}-ledger`,
    buckets: [{ binding: 'GALLERY_FILES', bucket: `${prefix}-gallery-files` }],
    calendarFeedsBucket: `${prefix}-calendar-feeds`,
    calendarPublicWorker: `${prefix}-calendar-public`,
    publicWorkers: [`${prefix}-gallery-public`],
});

const shared = resources('st');
const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
    site: {
        id: 'owned',
        origin: 'https://owned.example.workers.dev',
        features: ['calc', 'calendar'],
        authorizedEmails: ['owner@example.com'],
        ledgerAppName: 'owned',
        deployment: { resourcePrefix: 'owned-prod', accountId: 'a'.repeat(32) },
    },
    modules: [{ id: 'org.stor.calc', version: '1.0.0' }],
    resources: resources('owned-prod'),
    accessTeamDomain: 'https://team.cloudflareaccess.com',
    others: [{ id: 'jst', resources: resources('jst-prod') }],
    shared,
    ...overrides,
});

test('a tenant with its own names plans cleanly and in order', () => {
    const plan = planDeployment(input());
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.topology, 'dedicated');
    assert.deepEqual(plan.steps.map((step) => step.id), ['resources', 'ledger', 'ledger-app', 'frontend', 'verify']);
    assert.ok(plan.resources.some((resource) => resource.kind === 'ledger-worker' && resource.name === 'owned-prod-ledger' && resource.stateful));
    assert.ok(plan.resources.some((resource) => resource.kind === 'r2-bucket' && resource.name === 'owned-prod-ledger-archive' && resource.stateful));
    assert.ok(newReceipt(plan).resources.includes('r2-bucket:owned-prod-ledger-archive'));
    assert.match(renderPlan(plan), /never deleted/);
});

test('a tenant on the shared stack plans no Ledger deploy of its own', () => {
    const plan = planDeployment(input({
        site: { ...input().site, id: 'bravo', deployment: null },
        resources: shared,
    }));
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.steps.map((step) => step.id), ['resources', 'ledger-app', 'frontend', 'verify']);
});

test('a dedicated tenant is refused when a bucket or Worker is another tenant\'s or the shared stack\'s', () => {
    const takesNeighbourBucket = planDeployment(input({
        resources: { ...resources('owned-prod'), buckets: [{ binding: 'GALLERY_FILES', bucket: 'jst-prod-gallery-files' }] },
    }));
    assert.ok(takesNeighbourBucket.problems.some((problem) => /jst-prod-gallery-files.*site "jst"/.test(problem)));
    const takesSharedLedger = planDeployment(input({ resources: { ...resources('owned-prod'), ledgerWorker: 'st-ledger' } }));
    assert.ok(takesSharedLedger.problems.some((problem) => /st-ledger.*shared stack/.test(problem)));
    const takesArchive = planDeployment(input({ resources: { ...resources('owned-prod'),
        buckets: [{ binding: 'GALLERY_FILES', bucket: 'jst-prod-ledger-archive' }] } }));
    assert.ok(takesArchive.problems.some((problem) => /jst-prod-ledger-archive.*site "jst"/.test(problem)));
    const strayName = planDeployment(input({ resources: { ...resources('owned-prod'), calendarFeedsBucket: 'feeds' } }));
    assert.ok(strayName.problems.some((problem) => /resource prefix/.test(problem)));
});

test('a plan without an Access team or users is refused rather than deployed unprotected', () => {
    assert.ok(planDeployment(input({ accessTeamDomain: '' })).problems.some((problem) => /unprotected/.test(problem)));
    const noUsers = input();
    assert.ok(planDeployment({ ...noUsers, site: { ...noUsers.site, authorizedEmails: [] } }).problems.some((problem) => /No user/.test(problem)));
    const noAccount = planDeployment(input({ site: { ...input().site, deployment: { resourcePrefix: 'owned-prod' } } }));
    assert.deepEqual(noAccount.problems, []);
    assert.ok(noAccount.warnings.some((warning) => /accountId/.test(warning)));
});

const executors = (calls: StepId[], failAt?: StepId): Record<StepId, StepExecutor> => {
    const make = (id: StepId): StepExecutor => async () => {
        if (id === failAt) throw new Error('network went away');
        calls.push(id);
    };
    return { resources: make('resources'), ledger: make('ledger'), 'ledger-app': make('ledger-app'), frontend: make('frontend'), verify: make('verify') };
};

test('an interrupted apply resumes without running a finished step again, so credentials are minted once', async () => {
    const plan = planDeployment(input());
    let saved = newReceipt(plan);
    const save = async (receipt: typeof saved) => { saved = receipt; };

    const first: StepId[] = [];
    await assert.rejects(
        runApply(plan, { receipt: saved, executors: executors(first, 'frontend'), save }),
        (error: unknown) => error instanceof ApplyError && error.step === 'frontend',
    );
    assert.deepEqual(first, ['resources', 'ledger', 'ledger-app']);
    assert.deepEqual(Object.keys(saved.steps), ['resources', 'ledger', 'ledger-app']);

    const second: StepId[] = [];
    const result = await runApply(plan, { receipt: parseReceipt(serializeReceipt(saved)), executors: executors(second), save });
    assert.deepEqual(second, ['frontend', 'verify']);
    assert.deepEqual(result.skipped, ['resources', 'ledger', 'ledger-app']);

    const third: StepId[] = [];
    await runApply(plan, { receipt: saved, executors: executors(third), save });
    assert.deepEqual(third, []);
});

test('apply refuses a plan with problems and a receipt that belongs to other resources', async () => {
    const bad = planDeployment(input({ accessTeamDomain: '' }));
    const calls: StepId[] = [];
    await assert.rejects(runApply(bad, { receipt: newReceipt(bad), executors: executors(calls), save: async () => undefined }), /problems/);
    assert.deepEqual(calls, []);

    const plan = planDeployment(input());
    const other = planDeployment(input({ resources: resources('owned-prod2'), site: { ...input().site, deployment: { resourcePrefix: 'owned-prod2' } } }));
    await assert.rejects(runApply(plan, { receipt: newReceipt(other), executors: executors(calls), save: async () => undefined }), /Cannot resume/);
    assert.deepEqual(calls, []);
});

test('a receipt holds no secrets and cannot be made to', () => {
    const receipt = newReceipt(planDeployment(input()));
    assert.doesNotThrow(() => serializeReceipt(receipt));
    assert.throws(() => serializeReceipt({ ...receipt, steps: { resources: { completedAt: 'x', adminToken: 'y' } as never } }), /no secrets/);
});

test('apply can stop before a step, and a later run continues from there', async () => {
    const plan = planDeployment(input());
    let saved = newReceipt(plan);
    const save = async (receipt: typeof saved) => { saved = receipt; };
    const first: StepId[] = [];
    const stopped = await runApply(plan, { receipt: saved, executors: executors(first), save, stopBefore: 'frontend' });
    assert.deepEqual(first, ['resources', 'ledger', 'ledger-app']);
    assert.deepEqual(stopped.ran, ['resources', 'ledger', 'ledger-app']);
    const second: StepId[] = [];
    await runApply(plan, { receipt: saved, executors: executors(second), save });
    assert.deepEqual(second, ['frontend', 'verify']);
});
