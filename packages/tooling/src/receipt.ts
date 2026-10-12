/**
 * A deployment receipt: which steps of `hearthlog apply` finished and which
 * resources they concern. It lives in the operator's protected state and
 * holds no secret, so it can be read, copied, and attached to a support
 * request. A resumed apply trusts it to skip finished steps, which is how it
 * avoids minting a second set of credentials.
 */

import type { DeploymentPlan, StepId } from './plan.js';

export interface Receipt {
    schemaVersion: 1;
    siteId: string;
    origin: string;
    /** `kind:name` of every planned resource; a changed plan is not this receipt's deployment. */
    resources: string[];
    modules: Array<{ id: string; version: string }>;
    steps: Partial<Record<StepId, { completedAt: string }>>;
}

const SECRET_KEY = /token|secret|password|credential|private|signing/i;

export function newReceipt(plan: DeploymentPlan): Receipt {
    return {
        schemaVersion: 1,
        siteId: plan.siteId,
        origin: plan.origin,
        resources: plan.resources.map((resource) => `${resource.kind}:${resource.name}`).sort(),
        modules: plan.modules.map(({ id, version }) => ({ id, version })),
        steps: {},
    };
}

export function stepDone(receipt: Receipt, step: StepId): boolean {
    return receipt.steps[step] !== undefined;
}

export function recordStep(receipt: Receipt, step: StepId, at: Date): Receipt {
    return { ...receipt, steps: { ...receipt.steps, [step]: { completedAt: at.toISOString() } } };
}

/** Why a saved receipt cannot be resumed against this plan; empty when it can. */
export function receiptProblems(receipt: Receipt, plan: DeploymentPlan): string[] {
    const problems: string[] = [];
    if (receipt.schemaVersion !== 1) problems.push(`the receipt has schema version ${String(receipt.schemaVersion)}, not 1`);
    if (receipt.siteId !== plan.siteId) problems.push(`the receipt is for site "${receipt.siteId}", not "${plan.siteId}"`);
    const current = newReceipt(plan);
    if (receipt.origin !== current.origin) problems.push(`the receipt is for ${receipt.origin}, the plan for ${current.origin}`);
    if (JSON.stringify(receipt.resources) !== JSON.stringify(current.resources)) {
        problems.push('the planned resources differ from those the receipt recorded; remove the receipt only if you mean to start over');
    }
    return problems;
}

/** Serializes a receipt, refusing anything shaped like a secret. */
export function serializeReceipt(receipt: Receipt): string {
    const walk = (value: unknown, path: string): void => {
        if (value === null || typeof value !== 'object') return;
        for (const [key, inner] of Object.entries(value)) {
            if (SECRET_KEY.test(key)) throw new Error(`A receipt must hold no secrets (found "${path}${key}")`);
            walk(inner, `${path}${key}.`);
        }
    };
    walk(receipt, '');
    return `${JSON.stringify(receipt, null, 2)}\n`;
}

export function parseReceipt(text: string): Receipt {
    const value = JSON.parse(text) as Receipt;
    if (value === null || typeof value !== 'object' || value.schemaVersion !== 1 || typeof value.siteId !== 'string') {
        throw new Error('Not a deployment receipt');
    }
    return value;
}
