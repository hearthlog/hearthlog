import { NO_OPTION, type Decision, type DecisionOption } from "@hearthlog/contracts/ai/capabilities";

/**
 * The only file that knows which decision model answers. A question is a state
 * plus a fixed list of options; the answer is one option with a probability, or
 * `none`. Swapping Clef for another provider changes this file only.
 */

export const DECISION_MODEL = "@cf/cloudflare/clef-flash";

/** The part of the Workers AI binding the adapter uses. Scripts supply a REST-backed copy. */
export interface DecisionModelBinding {
    run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface DecisionQuestion {
    id: string;
    /** The facts, as text. */
    state: string;
    instructions: string;
    options: DecisionOption[];
}

export type DecisionModelErrorCode = "failed" | "timeout" | "invalid_output";

export class DecisionModelError extends Error {
    readonly code: DecisionModelErrorCode;

    constructor(code: DecisionModelErrorCode) {
        // Fixed messages only: inputs and outputs are never logged or echoed.
        super(`Decision model ${code}`);
        this.name = "DecisionModelError";
        this.code = code;
    }
}

const NONE_MEANING = "Unclear, or none of the other options fits";
const ANSWER_ID = "answer";

export interface DecideOptions {
    timeoutMs?: number;
    concurrency?: number;
    /** Receives the first raw model answer; used by the evaluation script to confirm the response shape. */
    onRawResponse?: (raw: unknown) => void;
}

/** Answers every question, a few at a time. Fails as a whole if one answer is unusable. */
export async function decide(
    ai: DecisionModelBinding,
    questions: DecisionQuestion[],
    { timeoutMs = 20_000, concurrency = 6, onRawResponse }: DecideOptions = {},
): Promise<{ model: string; decisions: Decision[] }> {
    const decisions: Decision[] = new Array(questions.length);
    let next = 0;
    let reported = false;
    const deadline = Date.now() + timeoutMs;

    async function worker(): Promise<void> {
        while (next < questions.length) {
            const index = next++;
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new DecisionModelError("timeout");
            const question = questions[index];
            const raw = await withTimeout(ai.run(DECISION_MODEL, buildInput(question)), remaining);
            if (!reported && onRawResponse) {
                reported = true;
                onRawResponse(raw);
            }
            decisions[index] = { id: question.id, ...readChoice(raw, question.options) };
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, () => worker()));
    return { model: DECISION_MODEL, decisions };
}

function buildInput(question: DecisionQuestion): Record<string, unknown> {
    const criteria: Record<string, string> = {};
    for (const option of question.options) criteria[option.value] = option.meaning;
    criteria[NO_OPTION] = NONE_MEANING;
    return {
        model: "clef-flash",
        state: question.state,
        questions: {
            [ANSWER_ID]: { type: "choice", instructions: question.instructions, criteria },
        },
    };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.catch(() => { throw new DecisionModelError("failed"); }),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new DecisionModelError("timeout")), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Reads the model's answer to one `choice` question as the most probable
 * option. The answer may be a map of option to probability (also nested under
 * `probabilities`/`scores`) or a list of entries; anything else, an option that
 * was not offered, or a probability outside 0 to 1 is rejected.
 */
export function readChoice(raw: unknown, options: DecisionOption[]): { option: string; probability: number } {
    const allowed = new Set<string>([...options.map((option) => option.value), NO_OPTION]);
    const answers = record(raw)?.answers;
    const answer = record(answers)?.[ANSWER_ID];
    const entries = probabilityEntries(answer);
    if (!entries || entries.length === 0) throw new DecisionModelError("invalid_output");

    let best: { option: string; probability: number } | null = null;
    for (const [option, probability] of entries) {
        if (!allowed.has(option) || !Number.isFinite(probability) || probability < 0 || probability > 1) {
            throw new DecisionModelError("invalid_output");
        }
        if (!best || probability > best.probability) best = { option, probability };
    }
    return best!;
}

function probabilityEntries(answer: unknown): Array<[string, number]> | null {
    if (Array.isArray(answer)) {
        const entries: Array<[string, number]> = [];
        for (const entry of answer) {
            const item = record(entry);
            const option = item && [item.option, item.label, item.id, item.choice].find((value) => typeof value === "string");
            const probability = item && [item.probability, item.score, item.p].find((value) => typeof value === "number");
            if (typeof option !== "string" || typeof probability !== "number") return null;
            entries.push([option, probability]);
        }
        return entries;
    }
    const value = record(answer);
    if (!value) return null;
    for (const key of ["probabilities", "scores", "options"]) {
        if (key in value) return probabilityEntries(value[key]);
    }
    const choice = [value.choice, value.option, value.label].find((entry) => typeof entry === "string");
    const probability = [value.probability, value.confidence, value.score].find((entry) => typeof entry === "number");
    if (typeof choice === "string" && typeof probability === "number") return [[choice, probability]];
    const entries = Object.entries(value);
    return entries.every(([, entry]) => typeof entry === "number") ? entries as Array<[string, number]> : null;
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
