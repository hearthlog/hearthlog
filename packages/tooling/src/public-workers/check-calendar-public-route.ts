/** Verify that the anonymous calendar feed hostname actually reaches its public Worker. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTenantConfig } from '../tenants/tenant-config.js';

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

const MISSING_FEED = `/feed/${'A'.repeat(43)}.ics`;
const ROBOTS = 'User-agent: *\nDisallow: /\n';
const NOINDEX = 'noindex, nofollow, noarchive';

export async function checkCalendarPublicRoute(origin: string, fetcher: Fetcher = fetch): Promise<void> {
    const options: RequestInit = { redirect: 'manual', signal: AbortSignal.timeout(10_000) };
    const missing = await fetcher(`${origin}${MISSING_FEED}`, options);
    const missingBody = await missing.text();
    if (missing.status !== 404 || missingBody !== 'Not found' || missing.headers.get('X-Robots-Tag') !== NOINDEX) {
        const body = missingBody.includes('There is nothing here yet') ? 'Cloudflare placeholder'
            : missingBody.includes('error code: 1042') ? 'Cloudflare error 1042'
            : missingBody.startsWith('<!DOCTYPE html>') ? 'unexpected HTML'
            : JSON.stringify(missingBody.slice(0, 80));
        throw new Error(`Public calendar route did not reach the Worker at ${origin}/feed/… (HTTP ${missing.status}, ${body}). Check the Worker deployment, workers.dev route, and Access rules.`);
    }
    const robots = await fetcher(`${origin}/robots.txt`, options);
    if (robots.status !== 200 || await robots.text() !== ROBOTS || robots.headers.get('X-Robots-Tag') !== NOINDEX) {
        throw new Error(`Public calendar Worker is not serving ${origin}/robots.txt (HTTP ${robots.status}). Check the Worker deployment and route.`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { infrastructure } = await loadTenantConfig();
    for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
            await checkCalendarPublicRoute(infrastructure.calendarPublicOrigin);
            break;
        } catch (cause) {
            if (attempt === 5) throw cause;
            await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
    }
    console.log(`Public calendar Worker is serving anonymously at ${infrastructure.calendarPublicOrigin}`);
}
