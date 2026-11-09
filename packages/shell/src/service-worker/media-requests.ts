/**
 * Media element loads and byte-range reads must go straight to the network.
 * When a worker answers them with `respondWith(fetch(request))`, WebKit (iOS
 * Safari and installed PWAs) plays from the start but stalls after a seek: the
 * aborted range request and its replacement both pass through the worker. The
 * worker gains nothing for these requests anyway, as they are never cached.
 */
export function bypassesWorker(request: Pick<Request, 'destination' | 'headers'>): boolean {
    return request.destination === 'video'
        || request.destination === 'audio'
        || request.headers.has('Range');
}
