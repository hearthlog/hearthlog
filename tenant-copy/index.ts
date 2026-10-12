/**
 * Short-lived Worker that copies one tenant's files into another tenant's
 * buckets, inside Cloudflare, keeping each object's content type and custom
 * metadata (Gallery's sha256, invoice file names).
 *
 * `pnpm tenant:copy -- files` deploys it with bindings to exactly the source
 * and target buckets, drives it with a random bearer token, and deletes it
 * when the copy finishes. Every request handles a small page so the Worker
 * stays inside its subrequest limit; the caller follows `cursor`.
 */

import {
    isOwnerRecord,
    rewriteOwner,
    type BucketPair,
    type TenantCopyMapping,
} from '../packages/tooling/src/tenants/tenant-copy-plan.ts';

interface CopyEnv {
    COPY_TOKEN?: string;
    SOURCE_INVOICE_PDFS: R2Bucket;
    TARGET_INVOICE_PDFS: R2Bucket;
    SOURCE_GALLERY_FILES: R2Bucket;
    TARGET_GALLERY_FILES: R2Bucket;
    SOURCE_GALLERY_PUBLIC: R2Bucket;
    TARGET_GALLERY_PUBLIC: R2Bucket;
}

interface PageRequest {
    pair: BucketPair;
    fromPrefix: string;
    toPrefix: string;
    cursor?: string;
    rewriteOwner?: boolean;
    mapping?: TenantCopyMapping;
}

const PAGE = 10;

function buckets(env: CopyEnv, pair: BucketPair): { source: R2Bucket; target: R2Bucket } {
    switch (pair) {
        case 'invoice-pdfs': return { source: env.SOURCE_INVOICE_PDFS, target: env.TARGET_INVOICE_PDFS };
        case 'gallery-files': return { source: env.SOURCE_GALLERY_FILES, target: env.TARGET_GALLERY_FILES };
        case 'gallery-public': return { source: env.SOURCE_GALLERY_PUBLIC, target: env.TARGET_GALLERY_PUBLIC };
    }
}

async function authorized(request: Request, env: CopyEnv): Promise<boolean> {
    const expected = env.COPY_TOKEN ?? '';
    const supplied = request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    if (expected.length < 32 || supplied.length !== expected.length) return false;
    const [a, b] = await Promise.all([expected, supplied].map((value) =>
        crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
    const left = new Uint8Array(a!);
    const right = new Uint8Array(b!);
    let difference = 0;
    for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
    return difference === 0;
}

function targetKey(job: PageRequest, key: string): string {
    if (!key.startsWith(job.fromPrefix)) throw new Error('listed key outside the prefix');
    return job.toPrefix + key.slice(job.fromPrefix.length);
}

/** Same content: equal ETags (MD5) for single-part objects, equal sizes otherwise. */
function sameContent(source: R2Object, target: R2Object | null): boolean {
    if (!target || target.size !== source.size) return false;
    return source.etag.includes('-') || target.etag === source.etag;
}

async function ownerBody(source: R2Bucket, key: string, mapping: TenantCopyMapping | undefined): Promise<string> {
    if (!mapping) throw new Error('owner rewrite needs the mapping');
    const object = await source.get(key);
    if (!object) throw new Error(`object vanished: ${key}`);
    return JSON.stringify(rewriteOwner(await object.json(), mapping));
}

async function copyPage(env: CopyEnv, job: PageRequest) {
    const { source, target } = buckets(env, job.pair);
    const listed = await source.list({ prefix: job.fromPrefix, cursor: job.cursor, limit: PAGE, include: ['httpMetadata', 'customMetadata'] });
    let copied = 0;
    let skipped = 0;
    let bytes = 0;
    for (const object of listed.objects) {
        const key = targetKey(job, object.key);
        if (job.rewriteOwner && isOwnerRecord(object.key)) {
            const body = await ownerBody(source, object.key, job.mapping);
            const existing = await target.get(key);
            if (existing && await existing.text() === body) { skipped++; continue; }
            await target.put(key, body, { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
            copied++;
            continue;
        }
        if (sameContent(object, await target.head(key))) { skipped++; continue; }
        const body = await source.get(object.key);
        if (!body) throw new Error(`object vanished: ${object.key}`);
        await target.put(key, body.body, { httpMetadata: object.httpMetadata, customMetadata: object.customMetadata });
        copied++;
        bytes += object.size;
    }
    return { copied, skipped, bytes, cursor: listed.truncated ? listed.cursor : null };
}

async function comparePage(env: CopyEnv, job: PageRequest) {
    const { source, target } = buckets(env, job.pair);
    const listed = await source.list({ prefix: job.fromPrefix, cursor: job.cursor, limit: PAGE * 5 });
    const problems: string[] = [];
    for (const object of listed.objects) {
        const key = targetKey(job, object.key);
        if (job.rewriteOwner && isOwnerRecord(object.key)) {
            const existing = await target.get(key);
            if (!existing || await existing.text() !== await ownerBody(source, object.key, job.mapping)) problems.push(key);
            continue;
        }
        if (!sameContent(object, await target.head(key))) problems.push(key);
    }
    return { checked: listed.objects.length, problems, cursor: listed.truncated ? listed.cursor : null };
}

/** Publications whose owner record names the source app. */
async function ownedPublications(env: CopyEnv, appId: string, cursor: string | undefined) {
    const listed = await env.SOURCE_GALLERY_FILES.list({ prefix: 'v1/publications/', delimiter: '/', cursor, limit: PAGE * 5 });
    const owned: string[] = [];
    for (const prefix of listed.delimitedPrefixes) {
        const id = prefix.slice('v1/publications/'.length, -1);
        const owner = await env.SOURCE_GALLERY_FILES.get(`${prefix}owner.json`);
        if (!owner) continue;
        const record = await owner.json<{ appId?: unknown }>();
        if (record.appId === appId) owned.push(id);
    }
    return { owned, cursor: listed.truncated ? listed.cursor : null };
}

export default {
    async fetch(request: Request, env: CopyEnv): Promise<Response> {
        if (request.method !== 'POST' || !await authorized(request, env)) {
            return new Response('Not found', { status: 404 });
        }
        const path = new URL(request.url).pathname;
        try {
            const body = await request.json<PageRequest & { appId?: string }>();
            if (path === '/copy') return Response.json(await copyPage(env, body));
            if (path === '/compare') return Response.json(await comparePage(env, body));
            if (path === '/publications' && body.appId) return Response.json(await ownedPublications(env, body.appId, body.cursor));
            return new Response('Not found', { status: 404 });
        } catch (error) {
            return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
    },
};
