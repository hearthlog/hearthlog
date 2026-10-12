import type { LogSummary } from "./ledger/index.js";

function logNamesMatch(left: string, right: string): boolean {
    return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

export function validateNewLogName(
    name: string,
    existingLogs: readonly LogSummary[],
): string {
    const normalized = name.trim();
    if (!normalized) throw new Error("Enter a log name.");

    if (existingLogs.some((log) => logNamesMatch(log.name, normalized))) {
        throw new Error(`A log named "${normalized}" already exists.`);
    }

    return normalized;
}
