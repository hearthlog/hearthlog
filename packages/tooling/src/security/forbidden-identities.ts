/**
 * The identities that must never reach a public repository (plan, section 4).
 *
 * They live in a file in the operator's home directory, never in the repository: a committed
 * list of forbidden values would itself leak them. The audit and the snapshot refuse to run
 * without it, and nothing here, in an error, or in a report prints a value from it; findings name
 * the entry by number.
 *
 *   {
 *     "forbidden": ["strings, matched case-insensitively anywhere: addresses, domains, company names"],
 *     "allowedAuthorEmails": ["the only address commits may carry"]
 *   }
 *
 * The location is `$HEARTHLOG_FORBIDDEN_FILE`, else `$XDG_CONFIG_HOME/hearthlog/forbidden.json`,
 * else `~/.config/hearthlog/forbidden.json`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ForbiddenList {
    path: string;
    /** Lower-cased, distinct, each at least `MIN_LENGTH` characters. */
    forbidden: string[];
    /** Commit authors and committers the push gate accepts. */
    allowedAuthorEmails: string[];
}

export class ForbiddenListError extends Error {}

const MIN_LENGTH = 4;
const MAX_LENGTH = 200;

export function forbiddenListPath(env: NodeJS.ProcessEnv = process.env): string {
    if (env.HEARTHLOG_FORBIDDEN_FILE) return env.HEARTHLOG_FORBIDDEN_FILE;
    return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hearthlog", "forbidden.json");
}

/** Validates the file's content. Errors say what is wrong, never what the values are. */
export function parseForbiddenList(text: string, path: string): ForbiddenList {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new ForbiddenListError(`${path} is not valid JSON.`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ForbiddenListError(`${path} must be a JSON object.`);
    const record = value as Record<string, unknown>;
    const strings = (key: string, minimum: number): string[] => {
        const entries = record[key];
        if (entries === undefined) return [];
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) throw new ForbiddenListError(`"${key}" in ${path} must be a list of strings.`);
        const trimmed = (entries as string[]).map((entry) => entry.trim());
        const index = trimmed.findIndex((entry) => entry.length < minimum || entry.length > MAX_LENGTH);
        if (index !== -1) throw new ForbiddenListError(`"${key}" entry #${index + 1} in ${path} must be ${minimum} to ${MAX_LENGTH} characters.`);
        return [...new Set(trimmed.map((entry) => entry.toLowerCase()))];
    };
    const forbidden = strings("forbidden", MIN_LENGTH);
    if (forbidden.length === 0) throw new ForbiddenListError(`"forbidden" in ${path} must list at least one string.`);
    const allowedAuthorEmails = strings("allowedAuthorEmails", 3);
    const bad = allowedAuthorEmails.findIndex((email) => !email.includes("@"));
    if (bad !== -1) throw new ForbiddenListError(`"allowedAuthorEmails" entry #${bad + 1} in ${path} is not an email address.`);
    return { path, forbidden, allowedAuthorEmails };
}

export function loadForbiddenList(env: NodeJS.ProcessEnv = process.env): ForbiddenList {
    const path = forbiddenListPath(env);
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        throw new ForbiddenListError(
            `The forbidden-identities file ${path} does not exist. It lists what must never be published (work addresses, employer and company names). ` +
                "Create it with `pnpm audit:forbidden:init`, review it, and run this again.",
        );
    }
    return parseForbiddenList(text, path);
}

/** Entry numbers (1-based) of the forbidden strings that occur in the text. */
export function forbiddenIn(text: string, forbidden: readonly string[]): number[] {
    const lower = text.toLowerCase();
    const found: number[] = [];
    forbidden.forEach((entry, index) => {
        if (lower.includes(entry)) found.push(index + 1);
    });
    return found;
}

/** The same search over bytes, so an image's metadata or a binary file cannot hide a value. */
export function forbiddenInBytes(buffer: Buffer, forbidden: readonly string[]): number[] {
    return forbiddenIn(buffer.toString("latin1"), forbidden.map((entry) => Buffer.from(entry, "utf8").toString("latin1")));
}

/** The text with every forbidden value replaced by its entry number, for paths a report must show. */
export function maskForbidden(text: string, forbidden: readonly string[]): string {
    let masked = text;
    [...forbidden.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .forEach(([index, entry]) => {
            masked = masked.replace(new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), `<forbidden #${index + 1}>`);
        });
    return masked;
}

export const forbiddenLabel = (entry: number): string => `forbidden entry #${entry}`;
