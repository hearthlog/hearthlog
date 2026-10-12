import { deferPage } from '@hearthlog/runtime/runtime/page-data.svelte.js';
import { getEntityDefinition, getPayloadKey } from '@hearthlog/contracts/event/entity-definitions';
import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent<{ type: string }>) => unknown;
import { error, redirect } from '@sveltejs/kit';
import { queryDatabase } from '@hearthlog/runtime/db/read-repositories.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
import { tenantRouteRedirect } from '@hearthlog/contracts/tenant/route-access';
import { withTiming, measurementMetadata } from '@hearthlog/runtime/utils/perf.js';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 20;

const loadData = async ({ params, url, depends }: Parameters<PageLoad>[0]) => {

    const entityName = params.type;

    const redirectTarget = tenantRouteRedirect(`/entities/${entityName}`, tenant);
    if (redirectTarget) redirect(307, redirectTarget);

    let rowCount = 0;
    let referenceFieldCount = 0;
    const metadata = measurementMetadata();

    const result = await withTiming(
        'ui',
        'loadEntityPage',
        () => queryDatabase(async (repositories) => {
            const repository = repositories.entities;
            const entityType = await repository.getEntityType(entityName);
            if (!entityType) {
                throw error(
                    404,
                    `Entity type "${entityName}" is not available in this view.`,
                );
            }
            referenceFieldCount = entityType.fields.filter((field) => field.type === 'reference').length;
            const result = await repository.queryEntities(entityName, {
                search: (url.searchParams.get('search') ?? '').trim(),
                pageSize: parsePageSize(url.searchParams.get('pageSize')),
                requestedPage: parsePage(url.searchParams.get('page')),
                sortField: url.searchParams.get('sort'),
                sortDirection: url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc',
            });
            if (!result) throw error(404, `Entity type "${entityName}" not found.`);
            rowCount = result.totalRows;
            return result;
        }),
        () => ({
            ...metadata, kind: 'operation', route: `/entities/${entityName}`,
            baselineMetric: 'entityPageLoadTime',
            entityType: entityName,
            rowCount,
            referenceFieldCount,
        }),
    );

    return {
        ...result,
    };
};

function parsePageSize(value: string | null): number {
    const parsed = Number(value);
    return PAGE_SIZE_OPTIONS.includes(parsed as (typeof PAGE_SIZE_OPTIONS)[number])
        ? parsed
        : DEFAULT_PAGE_SIZE;
}

function parsePage(value: string | null): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export const load = ((event) => {
    event.depends('app:entities'); const target = tenantRouteRedirect(`/entities/${event.params.type}`, tenant); if (target) redirect(307, target);
    const definition = getEntityDefinition(event.params.type);
    return deferPage(event, { entityType: { name: event.params.type, display_name: definition?.displayName ?? event.params.type.replace(/(^|_)([a-z])/g, (_, separator, letter) => `${separator ? ' ' : ''}${letter.toUpperCase()}`), id: '', tenant_id: '', log_id: '', created_at: '', updated_at: '', is_archived: 0, is_static: Boolean(definition), table_name: event.params.type, fields_json: '[]', calendar_json: null }, fields: definition?.fields.map(field => ({ ...field, payloadKey: getPayloadKey(field) })) ?? [], entities: [], referenceOptions: {}, referencedBy: {}, totalRows: 0, totalPages: 1, currentPage: parsePage(event.url.searchParams.get('page')), pageSize: parsePageSize(event.url.searchParams.get('pageSize')), search: event.url.searchParams.get('search') ?? '', sortField: event.url.searchParams.get('sort'), sortDirection: event.url.searchParams.get('direction') === 'desc' ? 'desc' : 'asc' } as Awaited<ReturnType<typeof loadData>>, () => loadData(event));
}) satisfies PageLoad;
