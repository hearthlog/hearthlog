import type { WorkspaceRecord } from './point-snapshot.js';

export interface HistoryChange {
    key: string;
    label: string;
    kind: 'added' | 'changed' | 'removed';
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
}

export function compareWorkspaceRecords(before: WorkspaceRecord[], after: WorkspaceRecord[]): HistoryChange[] {
    const previous = new Map(before.map(record => [record.key, record]));
    const next = new Map(after.map(record => [record.key, record]));
    const changes: HistoryChange[] = [];
    for (const key of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
        const left = previous.get(key), right = next.get(key);
        if (left && right && stableJson(left.value) === stableJson(right.value)) continue;
        changes.push({ key, label: (right ?? left)!.label, kind: !left ? 'added' : !right ? 'removed' : 'changed',
            ...(left ? { before: left.value } : {}), ...(right ? { after: right.value } : {}) });
    }
    return changes;
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
    return JSON.stringify(value);
}
