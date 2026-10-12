import type { HistoryChange } from './change-comparison.js';
import { formatNumber } from '@hearthlog/ui/utils/number-format.js';

export interface ChangedField {
    key: string;
    label: string;
    before: string;
    after: string;
}

const hiddenFields = new Set(['id', 'tenant_id', 'log_id', 'created_at', 'updated_at']);

function sameValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function fieldChanges(change: HistoryChange): ChangedField[] {
    const before = change.before ?? {};
    const after = change.after ?? {};
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter(key => !hiddenFields.has(key) && !sameValue(before[key], after[key]))
        .sort((left, right) => left.localeCompare(right))
        .map(key => ({
            key,
            label: key.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()),
            before: displayHistoryValue(before[key]),
            after: displayHistoryValue(after[key]),
        }));
}

export function displayHistoryValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'number') return formatNumber(value, 4);
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

export function changeVerb(kind: HistoryChange['kind']): string {
    return kind === 'added' ? 'Added' : kind === 'removed' ? 'Removed' : 'Changed';
}
