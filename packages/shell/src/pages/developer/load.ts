import type { LoadEvent } from '@sveltejs/kit';
type PageLoad = (event: LoadEvent) => unknown;
import { deferPage } from '@hearthlog/runtime/runtime/page-data.svelte.js';
import { getAllEvents } from '@hearthlog/runtime/event/index.js';
import { getAllOutboxEvents } from '@hearthlog/runtime/store/outbox.js';
import { loadRawSqliteTablePage, parseRawSqlitePage, parseRawSqlitePageSize, parseRawSqliteSortDirection, parseRawSqliteSortField } from '@hearthlog/runtime/db/raw-browser.js';
import { loadLocalSqliteStats } from '@hearthlog/runtime/db/local-statistics.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
export const load = ((event) => {
    event.depends('app:developer');
    const requestedTab = event.url.searchParams.get('tab');
    const tab = requestedTab === 'events' || requestedTab === 'database' || requestedTab === 'performance'
        || (requestedTab === 'ledger' && tenant.admin) ? requestedTab : 'overview';
    const table = event.url.searchParams.get('table');
    const page = parseRawSqlitePage(event.url.searchParams.get('page'));
    const pageSize = parseRawSqlitePageSize(event.url.searchParams.get('pageSize'));
    const sort = parseRawSqliteSortField(event.url.searchParams.get('sort'));
    const direction = parseRawSqliteSortDirection(event.url.searchParams.get('direction'));
    return deferPage(event, { events: [], outboxEvents: [], databasePage: null, sqliteStats: null }, async () => {
        const [events, outboxEvents, databasePage, sqliteStats] = await Promise.all([
            tab === 'events' ? getAllEvents() : Promise.resolve([]),
            tab === 'overview' ? getAllOutboxEvents() : Promise.resolve([]),
            tab === 'database' ? loadRawSqliteTablePage({ tableName: table, page, pageSize, sort, direction }) : Promise.resolve(null),
            tab === 'overview' || tab === 'database' ? loadLocalSqliteStats() : Promise.resolve(null),
        ]);
        return { events, outboxEvents, databasePage, sqliteStats };
    });
}) satisfies PageLoad;
