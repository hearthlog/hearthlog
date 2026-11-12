import { describe, expect, it } from 'vitest';
import { layoutTimeline } from './timeline-layout.js';

const DAY = 24 * 60 * 60 * 1000;
const base = new Date(2026, 10, 12, 12).getTime();
const row = (id: string, version: number | null, daysAgo = 0) => ({ id, version, timestamp: base - daysAgo * DAY });
const marker = (key: string, version: number) => ({ key, version });
const fold = (key: string, firstVersion: number, lastVersion: number) => ({ key, firstVersion, lastVersion });
const keys = (entries: ReturnType<typeof layoutTimeline>) => entries.map((entry) => entry.key);

describe('timeline layout', () => {
    it('places fork points above the action they share, below waiting rows, and marks new days', () => {
        const entries = layoutTimeline({
            rows: [row('waiting', null), row('a9', 9), row('a7', 7, 1), row('a3', 3, 1)],
            markers: [marker('branch', 7), marker('start', 0)],
            folds: [],
            complete: true,
        });
        expect(keys(entries)).toEqual(['waiting', 'a9', 'marker:branch', 'a7', 'a3', 'marker:start']);
        expect(entries.filter((entry) => entry.kind === 'row').map((entry) => entry.kind === 'row' && entry.startsDay))
            .toEqual([true, false, true, false]);
    });

    it('holds fork points below the loaded rows until the list is complete', () => {
        const entries = layoutTimeline({ rows: [row('a9', 9)], markers: [marker('start', 2)], folds: [], complete: false });
        expect(keys(entries)).toEqual(['a9']);
    });

    it('puts older fork points among the folded months', () => {
        const entries = layoutTimeline({
            rows: [row('a90', 90), row('a80', 80)],
            markers: [marker('recent', 85), marker('old', 30), marker('start', 0)],
            folds: [fold('2026-09', 41, 79), fold('2026-08', 1, 40)],
            complete: true,
        });
        expect(keys(entries)).toEqual(['a90', 'marker:recent', 'a80', 'fold:2026-09', 'marker:old', 'fold:2026-08', 'marker:start']);
    });
});
