/**
 * Decision capabilities: questions with a fixed set of answers that a small
 * decision model picks from. Shared by the browser, the frontend Worker and
 * scripts, so it stays free of Svelte, `$app` and Worker globals.
 *
 * The browser sends data, never prompt text or option lists: the Worker owns
 * the question and the options of every capability.
 */

import { MODULE_AI_CAPABILITIES, type ModuleAiCapability } from '#generated/modules';

/** The capabilities the modules implement (`aiCapabilities` in their manifests). */
export const AI_CAPABILITIES: readonly AiCapability[] = MODULE_AI_CAPABILITIES;
export type AiCapability = ModuleAiCapability;

export function isAiCapability(value: unknown): value is AiCapability {
    return typeof value === 'string' && (AI_CAPABILITIES as readonly string[]).includes(value);
}

/** The answer a model gives when no option fits. It is never one of a capability's own options. */
export const NO_OPTION = 'none';

/** At or above this probability a suggestion is applied, with the Suggested tag. */
export const AUTO_APPLY_PROBABILITY = 0.9;
/** At or above this probability a suggestion is offered as a chip, not applied. */
export const OFFER_PROBABILITY = 0.5;

export type SuggestionBand = 'apply' | 'offer' | 'choose';

/** The three bands every suggestion surface shares. */
export function suggestionBand(option: string, probability: number): SuggestionBand {
    if (option === NO_OPTION || !Number.isFinite(probability)) return 'choose';
    if (probability >= AUTO_APPLY_PROBABILITY) return 'apply';
    if (probability >= OFFER_PROBABILITY) return 'offer';
    return 'choose';
}

/** Most items one request may carry. */
export const MAX_DECISION_ITEMS = 50;
/** Largest request body, in bytes. */
export const MAX_DECISION_BODY_BYTES = 64 * 1024;

/** The items a capability's module defines; the host only needs each to have an id. */
export interface DecisionRequest {
    items: Array<{ id: string }>;
}

export interface Decision {
    id: string;
    /** One of the capability's options, or {@link NO_OPTION}. */
    option: string;
    probability: number;
}

export interface DecisionResponse {
    model: string;
    decisions: Decision[];
}

export interface DecisionOption {
    value: string;
    /** What the option means, in words the model reads. */
    meaning: string;
}

/** Reads the comma-separated `AI_CAPABILITIES` Worker variable; unknown ids are ignored. */
export function parseEnabledCapabilities(value: string | null | undefined): Set<AiCapability> {
    return new Set(
        (value ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter(isAiCapability),
    );
}
