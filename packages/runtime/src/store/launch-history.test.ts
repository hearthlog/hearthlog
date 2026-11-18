import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH_HISTORY_KEY, LAUNCH_HISTORY_LIMIT, LaunchRecorder, readLaunchHistory } from './launch-history.js';

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
    };
}

describe('LaunchRecorder', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('keeps the costliest path and leads with its reason', () => {
        const storage = memoryStorage();
        const recorder = new LaunchRecorder(storage);
        recorder.path('schema-rebuild', 'Module projections changed.');
        recorder.path('snapshot-install', 'A newer snapshot existed.');
        recorder.path('schema-rebuild', 'Second rebuild.');
        expect(recorder.record.path).toBe('snapshot-install');
        expect(recorder.record.reasons[0]).toBe('A newer snapshot existed.');
    });

    it('is saved while it fills in and marked finished after the first download', () => {
        const storage = memoryStorage();
        const recorder = new LaunchRecorder(storage);
        recorder.note({ storage: 'opfs', logVersionAtStart: 120 });
        expect(readLaunchHistory(storage)[0]).toMatchObject({ storage: 'opfs', finished: false });
        expect(recorder.claimFirstDownload()).toBe(true);
        expect(recorder.claimFirstDownload()).toBe(false);
        recorder.note({ downloaded: 4 });
        recorder.finish();
        const [saved] = readLaunchHistory(storage);
        expect(saved).toMatchObject({ finished: true, downloaded: 4, path: 'opened' });
        expect(saved!.readyMs).not.toBeNull();
        expect(saved!.reasons).toHaveLength(1);
    });

    it('finishes without a ready time when no download comes', () => {
        const storage = memoryStorage();
        const recorder = new LaunchRecorder(storage);
        recorder.note({ storage: 'opfs' });
        vi.advanceTimersByTime(60_000);
        expect(recorder.finished).toBe(true);
        expect(readLaunchHistory(storage)[0]).toMatchObject({ finished: true, readyMs: null });
    });

    it('keeps only the newest launches and ignores damaged entries', () => {
        const storage = memoryStorage();
        storage.setItem(LAUNCH_HISTORY_KEY, JSON.stringify([{ nonsense: true }]));
        for (let index = 0; index < LAUNCH_HISTORY_LIMIT + 5; index++) new LaunchRecorder(storage, new Date(1_800_000_000_000 + index)).note({ downloaded: index });
        const history = readLaunchHistory(storage);
        expect(history).toHaveLength(LAUNCH_HISTORY_LIMIT);
        expect(history[0]!.downloaded).toBe(LAUNCH_HISTORY_LIMIT + 4);
    });
});
