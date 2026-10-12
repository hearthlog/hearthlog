/**
 * `hearthlog apply`: runs a plan's steps in order, recording each in the receipt as
 * it finishes. A resumed run skips what the receipt says is done, so an
 * interrupted apply continues where it stopped and a finished step that
 * minted credentials is never run again. Apply never deletes anything: it has
 * no step that does, and the engine refuses a plan with problems.
 */

import type { DeploymentPlan, PlannedStep, StepId } from './plan.js';
import { receiptProblems, recordStep, stepDone, type Receipt } from './receipt.js';

export type StepExecutor = (step: PlannedStep) => Promise<void>;

export interface ApplyOptions {
    receipt: Receipt;
    executors: Record<StepId, StepExecutor>;
    /** Persists the receipt; called after every finished step. */
    save: (receipt: Receipt) => Promise<void>;
    /**
     * Stop before this step instead of running it. A split provisions the new
     * stack with `stopBefore: 'frontend'` so traffic only switches after the
     * data has moved and been checked.
     */
    stopBefore?: StepId;
    now?: () => Date;
    log?: (message: string) => void;
}

export interface ApplyResult {
    ran: StepId[];
    skipped: StepId[];
    receipt: Receipt;
}

export class ApplyError extends Error {
    constructor(message: string, readonly step: StepId | null, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'ApplyError';
    }
}

export async function runApply(plan: DeploymentPlan, options: ApplyOptions): Promise<ApplyResult> {
    if (plan.problems.length) throw new ApplyError(`The plan has problems:\n  - ${plan.problems.join('\n  - ')}`, null);
    const mismatch = receiptProblems(options.receipt, plan);
    if (mismatch.length) throw new ApplyError(`Cannot resume:\n  - ${mismatch.join('\n  - ')}`, null);
    const now = options.now ?? (() => new Date());
    const log = options.log ?? (() => undefined);
    let receipt = options.receipt;
    const ran: StepId[] = [];
    const skipped: StepId[] = [];
    for (const step of plan.steps) {
        if (options.stopBefore === step.id) {
            log(`${step.id}: not run yet (stopped before it, as asked)`);
            break;
        }
        if (stepDone(receipt, step.id)) {
            log(`${step.id}: done earlier, skipped`);
            skipped.push(step.id);
            continue;
        }
        log(`${step.id}: ${step.summary}`);
        try {
            await options.executors[step.id](step);
        } catch (cause) {
            // What finished stays recorded; the failed step is repeated on the next run.
            throw new ApplyError(`Step "${step.id}" failed: ${cause instanceof Error ? cause.message : String(cause)}`, step.id, { cause });
        }
        receipt = recordStep(receipt, step.id, now());
        await options.save(receipt);
        ran.push(step.id);
    }
    return { ran, skipped, receipt };
}
