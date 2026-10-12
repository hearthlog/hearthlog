import { AccessSessionExpiredError, fetchAccessProtected } from '../access/session.js';
import { requireActiveContext } from '../db/index.js';
import { isAiCapabilityEnabled } from '@hearthlog/contracts/tenant/config';
import { withTimeout } from '../utils/async.js';
import {
    MAX_DECISION_ITEMS,
    type AiCapability,
    type Decision,
    type DecisionResponse,
} from '@hearthlog/contracts/ai/capabilities';

/**
 * Client for the same-origin decision route. It never throws: offline, a site
 * without the capability, a 503, a timeout or an unusable answer all return no
 * decisions (a partial batch keeps what was answered), so callers show no
 * suggestion and the manual path is unchanged.
 */

const TIMEOUT_MS = 30_000;

/** What the client got back. `answered` is false when the model could not be asked or failed. */
export interface DecisionResult extends DecisionResponse {
    answered: boolean;
}

const NONE: DecisionResult = { model: '', decisions: [], answered: false };

export async function requestDecisions(
    capability: AiCapability,
    items: ReadonlyArray<{ id: string }>,
): Promise<DecisionResult> {
    if (items.length === 0 || !isAiCapabilityEnabled(capability)) return NONE;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return NONE;
    let logId: string;
    try {
        logId = (await requireActiveContext()).logId;
    } catch {
        return NONE;
    }

    let model = '';
    let answered = false;
    const decisions: Decision[] = [];
    for (let start = 0; start < items.length; start += MAX_DECISION_ITEMS) {
        const chunk = items.slice(start, start + MAX_DECISION_ITEMS);
        const reply = await requestChunk(logId, capability, chunk);
        // A failed chunk ends the batch: later ones would most likely fail too.
        if (!reply) break;
        model = reply.model;
        decisions.push(...reply.decisions);
        answered = true;
    }
    return { model, decisions, answered };
}

async function requestChunk(logId: string, capability: AiCapability, items: unknown[]): Promise<DecisionResponse | null> {
    try {
        const response = await withTimeout(
            fetchAccessProtected(`/api/ai/v1/logs/${logId}/decisions/${capability}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
            }),
            TIMEOUT_MS,
            'AI decision request timed out',
        );
        if (!response.ok) return null;
        return parseResponse(await response.json(), items.length);
    } catch (error) {
        if (!(error instanceof AccessSessionExpiredError)) console.warn('[AI] Decision request failed');
        return null;
    }
}

function parseResponse(payload: unknown, expected: number): DecisionResponse | null {
    const record = payload as Partial<DecisionResponse> | null;
    if (!record || !Array.isArray(record.decisions) || record.decisions.length !== expected) return null;
    const decisions: Decision[] = [];
    for (const entry of record.decisions) {
        if (
            !entry || typeof entry.id !== 'string' || typeof entry.option !== 'string' ||
            typeof entry.probability !== 'number' || !Number.isFinite(entry.probability)
        ) {
            return null;
        }
        decisions.push({ id: entry.id, option: entry.option, probability: entry.probability });
    }
    return { model: typeof record.model === 'string' ? record.model : '', decisions };
}
