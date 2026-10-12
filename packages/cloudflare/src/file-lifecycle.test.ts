import { describe, expect, it } from 'vitest';
import type { FileContributor } from '@hearthlog/contracts';
import { planForkFiles } from './file-lifecycle';

const scope = {
    appId: '11111111-1111-4111-8111-111111111111',
    sourceLogId: '22222222-2222-4222-8222-222222222222',
    childLogId: '33333333-3333-4333-8333-333333333333',
};

describe('fork file lifecycle', () => {
    it('combines contributors, and a file any of them requires stays required', () => {
        const optional: FileContributor = () => [{ bucket: 'EXTRA_FILES', sourceKey: 'a', childKey: 'b', required: false }];
        const required: FileContributor = () => [
            { bucket: 'EXTRA_FILES', sourceKey: 'a', childKey: 'b', required: true },
            { bucket: 'OTHER_FILES', sourceKey: 'a', childKey: 'c', required: false },
        ];
        const files = planForkFiles([optional, required], [], scope);
        expect(files).toHaveLength(2);
        expect(files.find((file) => file.bucket === 'EXTRA_FILES')?.required).toBe(true);
    });

    it('passes the fork scope and history to every contributor', () => {
        const seen: unknown[] = [];
        const spy: FileContributor = (events, given) => { seen.push(events, given); return []; };
        planForkFiles([spy], [{ type: 'X_ADDED', payload: { id: 'x' } }], scope);
        expect(seen).toEqual([[{ type: 'X_ADDED', payload: { id: 'x' } }], scope]);
    });
});
