/**
 * Reads a request body while enforcing a byte cap.
 *
 * R2 rejects transformed streams: a `pipeThrough()` chain loses the request
 * body's known length and `put()` fails with "Provided readable stream must
 * have a known length". Callers therefore read and validate the capped bytes
 * before the conditional write. The cap bounds how much memory one request
 * can use; an empty body yields an empty array.
 *
 * Returns `null` when the body exceeds `maxBytes`.
 */
export async function readBodyCapped(
    body: ReadableStream<Uint8Array>,
    maxBytes: number,
): Promise<Uint8Array | null> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                // Stop the download; the caller answers 413 without storing.
                await reader.cancel().catch(() => { /* already closed */ });
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}
