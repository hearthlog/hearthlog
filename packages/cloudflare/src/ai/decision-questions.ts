import { AiRequestError, type AiCapabilityDefinition, type ServerModule } from "@hearthlog/contracts";
import { MAX_DECISION_ITEMS, type AiCapability } from "@hearthlog/contracts/ai/capabilities";
import type { DecisionQuestion } from "./decision-model";

/**
 * Per-capability request validation and question building. The browser sends
 * data; the question text and the options are built here, from code. Each
 * capability is defined by the module that owns its domain.
 */

export class DecisionRequestError extends AiRequestError {}

/** The definition a module the site enables contributes. */
export function definitionFor(modules: ReadonlyArray<ServerModule<Env>>, capability: AiCapability): AiCapabilityDefinition {
    for (const module of modules) {
        const definition = module.ai?.[capability];
        if (definition) return definition;
    }
    throw new AiRequestError("This capability is not installed");
}

export function parseItems(modules: ReadonlyArray<ServerModule<Env>>, capability: AiCapability, body: unknown): Array<{ id: string }> {
    const items = (body as { items?: unknown } | null)?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_DECISION_ITEMS) {
        throw new DecisionRequestError(`Send 1 to ${MAX_DECISION_ITEMS} items`);
    }
    const definition = definitionFor(modules, capability);
    const seen = new Set<string>();
    return items.map((item) => {
        const value = definition.parseItem(item);
        if (seen.has(value.id)) throw new DecisionRequestError("Item ids must be unique");
        seen.add(value.id);
        return value;
    });
}

export function buildQuestion(modules: ReadonlyArray<ServerModule<Env>>, capability: AiCapability, item: { id: string }): DecisionQuestion {
    const definition = definitionFor(modules, capability);
    return { id: item.id, ...definition.question(item), options: definition.options() };
}
