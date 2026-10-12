import { beginWorkspaceTransition, completeWorkspaceTransition, failWorkspaceTransition } from '@hearthlog/ui/state/readiness.js';
import { db, requireActiveContext } from '../db/index.js';
import type { Kysely } from 'kysely';
import {
    beginApplicationViewTransition,
    cancelApplicationViewTransition,
    updateApplicationView,
} from './view.js';
import { createReadModelSession, type ReadModelDatabase, type ReadModelSession, type ReadScope, type ReadView } from '../db/read-session.js';

type ActiveReadTarget = { scope: ReadScope; view: ReadView };
type CoordinatorState = {
    activeTarget: ActiveReadTarget | null;
    activationQueue: Promise<void>;
    waiters: Array<{ resolve: (target: ActiveReadTarget) => void; reject: (error: unknown) => void }>;
    error: unknown;
    transitioning: boolean;
};

const globalForCoordinator = globalThis as unknown as { storReadCoordinator?: CoordinatorState };
const coordinatorState = globalForCoordinator.storReadCoordinator ?? {
    activeTarget: null,
    activationQueue: Promise.resolve(),
    waiters: [],
    error: null,
    transitioning: false,
};
globalForCoordinator.storReadCoordinator = coordinatorState;

export async function activateCurrentReadTarget(now = new Date()): Promise<void> {
    const context = await requireActiveContext();
    const scope = { tenantId: context.tenantId, logId: context.logId };
    const view = { effectiveNow: now.toISOString() };
    const activation = coordinatorState.activationQueue.then(() => {
        coordinatorState.activeTarget = { scope, view };
        coordinatorState.transitioning = false;
        coordinatorState.error = null;
        completeWorkspaceTransition(JSON.stringify([scope.tenantId, scope.logId]));
        for (const waiter of coordinatorState.waiters.splice(0)) waiter.resolve(coordinatorState.activeTarget);
        updateApplicationView({ effectiveNow: view.effectiveNow });
    });
    coordinatorState.activationQueue = activation.catch(() => undefined);
    await activation;
}

/**
 * Moves the active read target's clock forward. A log transition in progress
 * sets its own clock when it activates, so it is left alone.
 */
export async function advanceReadTargetClock(now = new Date()): Promise<boolean> {
    let advanced = false;
    const advance = coordinatorState.activationQueue.then(() => {
        const target = coordinatorState.activeTarget;
        if (!target || coordinatorState.transitioning) return;
        const view = { effectiveNow: now.toISOString() };
        coordinatorState.activeTarget = { scope: target.scope, view };
        updateApplicationView(view);
        advanced = true;
    });
    coordinatorState.activationQueue = advance.catch(() => undefined);
    await advance;
    return advanced;
}

export async function runActiveRead<T>(callback: (session: ReadModelSession) => Promise<T>): Promise<T> {
    const target = coordinatorState.activeTarget && !coordinatorState.transitioning
        ? coordinatorState.activeTarget
        : await waitForActiveTarget();
    return callback(createReadModelSession(db as unknown as Kysely<ReadModelDatabase>, {
        schema: 'main', scope: target.scope, view: target.view,
    }));
}

export function beginReadTargetTransition(): void {
    coordinatorState.error = null;
    beginWorkspaceTransition();
    coordinatorState.transitioning = true;
    beginApplicationViewTransition();
}

export function cancelReadTargetTransition(): void {
    coordinatorState.transitioning = false;
    cancelApplicationViewTransition();
    if (!coordinatorState.activeTarget) return;
    const { scope } = coordinatorState.activeTarget;
    completeWorkspaceTransition(JSON.stringify([scope.tenantId, scope.logId]));
    for (const waiter of coordinatorState.waiters.splice(0)) waiter.resolve(coordinatorState.activeTarget);
}

export function failReadTargetTransition(error: unknown): void {
    coordinatorState.error = error;
    coordinatorState.transitioning = true;
    failWorkspaceTransition(error);
    for (const waiter of coordinatorState.waiters.splice(0)) waiter.reject(error);
}

function waitForActiveTarget(): Promise<ActiveReadTarget> {
    if (coordinatorState.error) return Promise.reject(coordinatorState.error);
    if (coordinatorState.activeTarget && !coordinatorState.transitioning) {
        return Promise.resolve(coordinatorState.activeTarget);
    }
    return new Promise((resolve, reject) => coordinatorState.waiters.push({ resolve, reject }));
}
