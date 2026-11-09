import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bypassesWorker } from './media-requests.ts';

const request = (destination: string, headers: Record<string, string> = {}) =>
    ({ destination, headers: new Headers(headers) }) as Pick<Request, 'destination' | 'headers'>;

test('video and audio element loads skip the worker', () => {
    assert.equal(bypassesWorker(request('video')), true);
    assert.equal(bypassesWorker(request('audio')), true);
});

test('any byte-range read skips the worker', () => {
    assert.equal(bypassesWorker(request('', { Range: 'bytes=1000-' })), true);
});

test('ordinary API and asset requests stay routed', () => {
    assert.equal(bypassesWorker(request('')), false);
    assert.equal(bypassesWorker(request('image')), false);
    assert.equal(bypassesWorker(request('script')), false);
});
