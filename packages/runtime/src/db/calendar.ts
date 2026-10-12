import { sql, type RawBuilder } from 'kysely';
import {
    splitTitleRef,
    type EntityCalendarFilter,
} from '@hearthlog/contracts/calendar/config';
import {
    calendarSourceDefinitions,
    type CalendarSourceDefinition,
} from '@hearthlog/contracts/calendar/registry';
import type {
    CalendarBand,
    CalendarDay,
    CalendarPointItem,
    CalendarRangeItem,
    CalendarRangeResult,
    CalendarSourceCounts,
    CalendarSourceInfo,
    CalendarWeek,
} from '@hearthlog/contracts/calendar/types';
import type { CalendarEvent } from '#generated/schema';
import type { ReadModelSession } from './read-session.js';
import {
    visibleCalendarSourceKeys,
    type CalendarSourcePreference,
} from '../calendar/groups.js';
import { ENTITY_DEFINITIONS } from '@hearthlog/contracts/event/entity-definitions';
import { quoteIdentifier } from '../event/projection-builder.js';
import { tenant } from '@hearthlog/contracts/tenant/config';
import { withTimeout } from '../utils/async.js';

export type { CalendarEvent };

const DB_TIMEOUT_MS = 5000;

/** One approved entity date, resolved to a queryable table and column set. */
type ResolvedSource = CalendarSourceDefinition;

function quoteColumn(alias: string, name: string): RawBuilder<unknown> {
    return sql.raw(`${quoteIdentifier(alias)}.${quoteIdentifier(name)}`);
}

function valueOf(filter: EntityCalendarFilter): string | number {
    return typeof filter.equals === 'boolean'
        ? filter.equals
            ? 1
            : 0
        : filter.equals;
}

function filterSql(
    alias: string,
    filters: readonly EntityCalendarFilter[] | undefined,
): RawBuilder<unknown> {
    if (!filters || filters.length === 0) return sql``;
    const clauses = filters.map(
        (filter) => sql`${quoteColumn(alias, filter.field)} = ${valueOf(filter)}`,
    );
    return sql` AND ${sql.join(clauses, sql` AND `)}`;
}

/**
 * Title resolution: the configured ref, then configured fallbacks, then the
 * first of title/name/label that exists, then the record id. A ref may read a
 * JSON object key (`customer_snapshot#name`); malformed JSON is guarded so a
 * bad snapshot cannot break the month query.
 */
function titleSql(
    source: ResolvedSource,
    alias: string,
): RawBuilder<unknown> {
    const parts: RawBuilder<unknown>[] = [];
    if (source.config.titleField) {
        parts.push(titleRefSql(alias, source.config.titleField));
    }
    for (const ref of source.config.titleFallbacks ?? []) {
        parts.push(titleRefSql(alias, ref));
    }
    for (const fallback of ['title', 'name', 'label']) {
        if (source.fields.some((field) => field.name === fallback)) {
            parts.push(sql`NULLIF(TRIM(${quoteColumn(alias, fallback)}), '')`);
        }
    }
    parts.push(quoteColumn(alias, 'id'));
    return sql`COALESCE(${sql.join(parts, sql`, `)})`;
}

function titleRefSql(alias: string, ref: string): RawBuilder<unknown> {
    const { column, jsonKey } = splitTitleRef(ref);
    const value = quoteColumn(alias, column);
    if (!jsonKey) return sql`NULLIF(TRIM(${value}), '')`;
    // json_extract throws on malformed JSON; guard it like the invoice lists.
    return sql`CASE WHEN json_valid(${value}) THEN NULLIF(TRIM(json_extract(${value}, ${'$.' + jsonKey})), '') END`;
}

function subtitleSql(
    source: ResolvedSource,
    alias: string,
    parentAlias: string,
): RawBuilder<unknown> {
    const parts: RawBuilder<unknown>[] = [];
    if (source.config.subtitleField) {
        parts.push(
            sql`NULLIF(TRIM(${quoteColumn(alias, source.config.subtitleField)}), '')`,
        );
    }
    if (source.config.parent) {
        parts.push(
            sql`NULLIF(TRIM(${quoteColumn(parentAlias, source.config.parent.titleField)}), '')`,
        );
    }
    if (parts.length === 0) return sql`''`;
    return sql`COALESCE(${sql.join(parts, sql`, `)}, '')`;
}

function timeSql(
    alias: string,
    field: string | undefined,
): RawBuilder<unknown> {
    if (!field) return sql`''`;
    return sql`COALESCE(TRIM(${quoteColumn(alias, field)}), '')`;
}

function pinnedSql(
    source: ResolvedSource,
    alias: string,
): RawBuilder<unknown> {
    if (!source.config.pinnedField) return sql`0`;
    return sql`CASE WHEN ${quoteColumn(alias, source.config.pinnedField)} THEN 1 ELSE 0 END`;
}

/** JSON object of configured href params, empty object by default. */
function paramsSql(
    source: ResolvedSource,
    alias: string,
): RawBuilder<unknown> {
    const entries = Object.entries(source.config.params ?? {});
    if (entries.length === 0) return sql`'{}'`;
    const pairs: RawBuilder<unknown>[] = [];
    for (const [param, column] of entries) {
        pairs.push(sql`${param}`);
        pairs.push(
            sql`COALESCE(CAST(${quoteColumn(alias, column)} AS TEXT), '')`,
        );
    }
    return sql`json_object(${sql.join(pairs, sql`, `)})`;
}

function parentJoinSql(
    session: ReadModelSession,
    source: ResolvedSource,
    alias: string,
): RawBuilder<unknown> {
    const parent = source.config.parent;
    if (!parent) return sql``;
    return sql`INNER JOIN ${session.table(parent.table)} AS p
        ON ${quoteColumn('p', 'id')} = ${quoteColumn(alias, parent.localField)}
        ${filterSql('p', parent.filters)}`;
}

function sourceArm(
    session: ReadModelSession,
    source: ResolvedSource,
    startDate: string,
    endDateExclusive: string,
    lastDay: string,
): RawBuilder<unknown> {
    const alias = 'src';
    const parentAlias = 'p';
    const config = source.config;
    const shared = {
        sourceKey: sql`${source.key}`,
        id: quoteColumn(alias, 'id'),
        title: titleSql(source, alias),
        subtitle: subtitleSql(source, alias, parentAlias),
        params: paramsSql(source, alias),
    };

    const from = sql`FROM ${session.table(source.table)} AS ${sql.raw(quoteIdentifier(alias))}`;
    const join = parentJoinSql(session, source, alias);

    if (config.endDateField) {
        // Multi-day source: clip the range to the requested window so the
        // client can place week segments without further SQL.
        const startField = quoteColumn(alias, config.dateField);
        const endField = quoteColumn(alias, config.endDateField);
        return sql`
            SELECT
                ${shared.sourceKey} AS source_key,
                'range' AS kind,
                ${shared.id} AS source_id,
                MAX(substr(TRIM(${startField}), 1, 10), ${startDate}) AS item_date,
                MIN(substr(TRIM(${endField}), 1, 10), ${lastDay}) AS end_date,
                ${timeSql(alias, config.timeField)} AS start_time,
                ${timeSql(alias, config.endTimeField)} AS end_time,
                ${shared.title} AS title,
                ${shared.subtitle} AS subtitle,
                ${shared.params} AS params,
                0 AS pinned
            ${from}
            ${join}
            WHERE TRIM(${startField}) <> ''
              AND TRIM(${endField}) <> ''
              AND ${startField} < ${endDateExclusive}
              AND ${endField} >= ${startDate}
              ${filterSql(alias, config.filters)}
        `;
    }

    const dateField = quoteColumn(alias, config.dateField);
    return sql`
        SELECT
            ${shared.sourceKey} AS source_key,
            'point' AS kind,
            ${shared.id} AS source_id,
            substr(TRIM(${dateField}), 1, 10) AS item_date,
            NULL AS end_date,
            ${timeSql(alias, config.timeField)} AS start_time,
            ${timeSql(alias, config.endTimeField)} AS end_time,
            ${shared.title} AS title,
            ${shared.subtitle} AS subtitle,
            ${shared.params} AS params,
            ${pinnedSql(source, alias)} AS pinned
        ${from}
        ${join}
        WHERE ${dateField} >= ${startDate}
          AND ${dateField} < ${endDateExclusive}
          ${filterSql(alias, config.filters)}
    `;
}

async function resolveSources(
    session: ReadModelSession,
): Promise<CalendarSourceDefinition[]> {
    const dynamicDefinitions = tenant.dynamicEntities
        ? await session
              .selectFrom('entity_type_definitions')
              .selectAll()
              .where('is_archived', '=', 0)
              .execute()
        : [];
    return calendarSourceDefinitions(
        ENTITY_DEFINITIONS,
        dynamicDefinitions,
        {
            approvedEntityNames: tenant.approvedEntities.entityNames,
            approvedTables: tenant.approvedEntities.tables,
            dynamicEnabled: tenant.dynamicEntities,
        },
    );
}

function previousDay(date: string): string {
    return addDays(date, -1);
}

function addDays(date: string, amount: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const value = new Date(Date.UTC(year, month - 1, day + amount));
    return value.toISOString().slice(0, 10);
}

function parseItemParams(value: unknown): Record<string, string> {
    if (typeof value !== 'string' || value.length === 0) return {};
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const params: Record<string, string> = {};
        for (const [key, entry] of Object.entries(parsed)) {
            params[key] = String(entry);
        }
        return params;
    } catch {
        return {};
    }
}

function parseDays(rows: ReadonlyArray<{ day: string; items: string }>): CalendarDay[] {
    const days: CalendarDay[] = [];
    for (const row of rows) {
        let rawItems: unknown;
        try {
            rawItems = JSON.parse(row.items);
        } catch {
            rawItems = [];
        }
        if (!Array.isArray(rawItems)) continue;
        days.push({ day: row.day, items: (rawItems as Array<Record<string, unknown>>).map(toPointItem) });
    }
    return days;
}

function toPointItem(raw: Record<string, unknown>): CalendarPointItem {
    return {
        sourceKey: String(raw.sourceKey ?? ''),
        id: String(raw.id ?? ''),
        startTime: String(raw.startTime ?? ''),
        endTime: String(raw.endTime ?? ''),
        title: String(raw.title ?? ''),
        subtitle: String(raw.subtitle ?? ''),
        pinned: Boolean(raw.pinned),
        params: parseItemParams(
            typeof raw.params === 'string'
                ? raw.params
                : JSON.stringify(raw.params ?? {}),
        ),
    };
}

function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
    if (typeof value !== 'string') return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseWeeks(rows: ReadonlyArray<{ week_start: string; days: string; bands: string }>): CalendarWeek[] {
    return rows.map((row) => ({
        start: row.week_start,
        days: parseJsonArray(row.days).map((day) => ({
            day: String(day.day ?? ''),
            items: (Array.isArray(day.items) ? day.items as Array<Record<string, unknown>> : []).map(toPointItem),
            lanes: Array.isArray(day.lanes) ? day.lanes.map(Number) : [],
        })),
        bands: parseJsonArray(row.bands).map((band): CalendarBand => ({
            range: {
                sourceKey: String(band.sourceKey ?? ''),
                id: String(band.id ?? ''),
                startDate: String(band.startDate ?? ''),
                endDate: String(band.endDate ?? ''),
                startTime: String(band.startTime ?? ''),
                endTime: String(band.endTime ?? ''),
                title: String(band.title ?? ''),
                subtitle: String(band.subtitle ?? ''),
                params: parseItemParams(JSON.stringify(band.params ?? {})),
            },
            startCol: Number(band.startCol),
            endCol: Number(band.endCol),
            lane: Number(band.lane),
        })),
    }));
}

function toSourceInfo(source: ResolvedSource): CalendarSourceInfo {
    return {
        key: source.key,
        entityName: source.entityName,
        label: source.label,
        dynamic: source.dynamic,
    };
}

export function createCalendarRepository(session: ReadModelSession) {
    async function selectSources(
        sourcePreference: CalendarSourcePreference | null,
    ): Promise<{ resolved: ResolvedSource[]; selected: ResolvedSource[] }> {
        const resolved = await resolveSources(session);
        // The stored preference hides groups; a preference that would hide every
        // available source falls back to showing all of them.
        const visible = visibleCalendarSourceKeys(resolved, sourcePreference);
        const selected = resolved.filter(
            (source) => visible === null || visible.has(source.key),
        );
        return { resolved, selected };
    }

    function unionSql(
        selected: readonly ResolvedSource[],
        startDate: string,
        endDateExclusive: string,
    ): RawBuilder<unknown> {
        const lastDay = previousDay(endDateExclusive);
        const arms = selected.map((source) => sourceArm(session, source, startDate, endDateExclusive, lastDay));
        return sql`${sql.join(arms, sql` UNION ALL `)}`;
    }

    async function getCalendarRange(
        startDate: string,
        endDateExclusive: string,
        sourcePreference: CalendarSourcePreference | null,
    ): Promise<CalendarRangeResult> {
        const { resolved, selected } = await selectSources(sourcePreference);
        const sources = resolved.map(toSourceInfo);
        if (selected.length === 0) {
            return { sources, days: [], ranges: [] };
        }

        const union = unionSql(selected, startDate, endDateExclusive);

        const [pointRows, rangeRows] = await Promise.all([
            withTimeout(
                session.execute(sql<{ day: string; items: string }>`
                    SELECT item_date AS day,
                           json_group_array(json_object(
                               'sourceKey', source_key,
                               'id', source_id,
                               'startTime', start_time,
                               'endTime', end_time,
                               'title', title,
                               'subtitle', subtitle,
                               'pinned', pinned,
                               'params', json(params)
                           )) AS items
                    FROM (
                        SELECT * FROM (${union}) AS all_items
                        WHERE kind = 'point'
                        ORDER BY item_date ASC, start_time ASC, source_key ASC, source_id ASC
                    ) AS ordered
                    GROUP BY item_date
                    ORDER BY day ASC
                `),
                DB_TIMEOUT_MS,
                'Calendar point query timed out',
            ),
            withTimeout(
                session.execute(sql<{
                    source_key: string;
                    source_id: string;
                    item_date: string;
                    end_date: string;
                    start_time: string;
                    end_time: string;
                    title: string;
                    subtitle: string;
                    params: string;
                }>`
                    SELECT * FROM (${union}) AS all_items
                    WHERE kind = 'range'
                    ORDER BY item_date ASC, end_date ASC, start_time ASC,
                             source_key ASC, source_id ASC
                `),
                DB_TIMEOUT_MS,
                'Calendar range query timed out',
            ),
        ]);

        const ranges: CalendarRangeItem[] = rangeRows.rows.map((row) => ({
            sourceKey: row.source_key,
            id: row.source_id,
            startDate: row.item_date,
            endDate: row.end_date,
            startTime: row.start_time,
            endTime: row.end_time,
            title: row.title,
            subtitle: row.subtitle,
            params: parseItemParams(row.params),
        }));

        return { sources, days: parseDays(pointRows.rows), ranges };
    }

    /** Every enabled source, regardless of the active filter. */
    async function getCalendarSources(): Promise<CalendarSourceInfo[]> {
        return (await resolveSources(session)).map(toSourceInfo);
    }

    /**
     * Whole Monday-first weeks for the endless calendar, one row per week
     * start given. Each week holds its seven days with their point items,
     * and its multi-day items as bands: the columns they cover and a lane
     * each, in the order `getCalendarRange` lists ranges. Every day also
     * lists the lanes covering it, so nothing is filtered on the client.
     */
    async function getCalendarWeeks(
        weekStarts: readonly string[],
        sourcePreference: CalendarSourcePreference | null,
    ): Promise<CalendarWeek[]> {
        if (weekStarts.length === 0) return [];
        const sorted = [...weekStarts].sort();
        const { selected } = await selectSources(sourcePreference);
        const items = selected.length > 0
            ? unionSql(selected, sorted[0], addDays(sorted[sorted.length - 1], 7))
            : sql`SELECT '' AS source_key, '' AS kind, '' AS source_id, '' AS item_date, '' AS end_date,
                         '' AS start_time, '' AS end_time, '' AS title, '' AS subtitle, '{}' AS params, 0 AS pinned
                  WHERE 0`;
        const weeks = sql.join(sorted.map((week) => sql`(${week})`), sql`, `);
        const result = await withTimeout(
            session.execute(sql<{ week_start: string; days: string; bands: string }>`
                WITH RECURSIVE
                    weeks(week_start) AS (VALUES ${weeks}),
                    cols(col) AS (SELECT 0 UNION ALL SELECT col + 1 FROM cols WHERE col < 6),
                    all_items AS (${items}),
                    points AS (
                        SELECT item_date AS day,
                               json_group_array(json_object(
                                   'sourceKey', source_key,
                                   'id', source_id,
                                   'startTime', start_time,
                                   'endTime', end_time,
                                   'title', title,
                                   'subtitle', subtitle,
                                   'pinned', pinned,
                                   'params', json(params)
                               ) ORDER BY start_time, source_key, source_id) AS items
                        FROM all_items
                        WHERE kind = 'point'
                        GROUP BY item_date
                    ),
                    bands AS (
                        SELECT w.week_start, r.*,
                               MAX(0, CAST(julianday(r.item_date) - julianday(w.week_start) AS INTEGER)) AS start_col,
                               MIN(6, CAST(julianday(r.end_date) - julianday(w.week_start) AS INTEGER)) AS end_col,
                               ROW_NUMBER() OVER (
                                   PARTITION BY w.week_start
                                   ORDER BY r.item_date, r.end_date, r.start_time, r.source_key, r.source_id
                               ) - 1 AS lane
                        FROM weeks AS w
                        JOIN all_items AS r
                          ON r.kind = 'range'
                         AND r.item_date < date(w.week_start, '+7 days')
                         AND r.end_date >= w.week_start
                    ),
                    lanes AS (
                        SELECT b.week_start, c.col, json_group_array(b.lane ORDER BY b.lane) AS lanes
                        FROM bands AS b
                        JOIN cols AS c ON c.col BETWEEN b.start_col AND b.end_col
                        GROUP BY b.week_start, c.col
                    ),
                    week_days AS (
                        SELECT w.week_start,
                               json_group_array(json_object(
                                   'day', date(w.week_start, '+' || c.col || ' days'),
                                   'items', json(COALESCE(p.items, '[]')),
                                   'lanes', json(COALESCE(l.lanes, '[]'))
                               ) ORDER BY c.col) AS days
                        FROM weeks AS w
                        CROSS JOIN cols AS c
                        LEFT JOIN points AS p ON p.day = date(w.week_start, '+' || c.col || ' days')
                        LEFT JOIN lanes AS l ON l.week_start = w.week_start AND l.col = c.col
                        GROUP BY w.week_start
                    ),
                    week_bands AS (
                        SELECT week_start,
                               json_group_array(json_object(
                                   'sourceKey', source_key,
                                   'id', source_id,
                                   'startDate', item_date,
                                   'endDate', end_date,
                                   'startTime', start_time,
                                   'endTime', end_time,
                                   'title', title,
                                   'subtitle', subtitle,
                                   'params', json(params),
                                   'startCol', start_col,
                                   'endCol', end_col,
                                   'lane', lane
                               ) ORDER BY lane) AS bands
                        FROM bands
                        GROUP BY week_start
                    )
                SELECT d.week_start, d.days, COALESCE(b.bands, '[]') AS bands
                FROM week_days AS d
                LEFT JOIN week_bands AS b ON b.week_start = d.week_start
                ORDER BY d.week_start
            `),
            DB_TIMEOUT_MS,
            'Calendar week query timed out',
        );
        return parseWeeks(result.rows);
    }

    /**
     * Count visible items per source in a window: points dated inside it and
     * multi-day ranges that overlap it, with the same source preference as
     * `getCalendarRange`.
     */
    async function getCalendarSourceCounts(
        startDate: string,
        endDateExclusive: string,
        sourcePreference: CalendarSourcePreference | null,
    ): Promise<CalendarSourceCounts> {
        const { selected } = await selectSources(sourcePreference);
        if (selected.length === 0) return { total: 0, sources: [] };
        const result = await withTimeout(
            session.execute(sql<{ source_key: string; item_count: number; total: number }>`
                SELECT source_key,
                       COUNT(*) AS item_count,
                       SUM(COUNT(*)) OVER () AS total
                FROM (${unionSql(selected, startDate, endDateExclusive)}) AS all_items
                GROUP BY source_key
                ORDER BY item_count DESC, source_key ASC
            `),
            DB_TIMEOUT_MS,
            'Calendar count query timed out',
        );
        return {
            total: Number(result.rows[0]?.total ?? 0),
            sources: result.rows.map((row) => ({
                sourceKey: row.source_key,
                count: Number(row.item_count),
            })),
        };
    }

    return {
        getCalendarRange,
        getCalendarSources,
        getCalendarWeeks,
        getCalendarSourceCounts,

        getCalendarEvent(id: string): Promise<CalendarEvent | undefined> {
            return withTimeout(
                session
                    .selectFrom('calendar_events')
                    .selectAll()
                    .where('id', '=', id)
                    .executeTakeFirst(),
                DB_TIMEOUT_MS,
                'Calendar event lookup timed out',
            );
        },

        getUpcomingPinnedCalendarEvents(
            today: string,
            limit?: number,
        ): Promise<CalendarEvent[]> {
            let query = session
                .selectFrom('calendar_events')
                .selectAll()
                .where('pinned', '=', true)
                .where('event_date', '>=', today)
                .orderBy('event_date', 'asc')
                .orderBy('start_time', 'asc')
                .orderBy('title', 'asc')
                .orderBy('id', 'asc');
            if (limit !== undefined) query = query.limit(limit);
            return withTimeout(
                query.execute(),
                DB_TIMEOUT_MS,
                'Pinned calendar event query timed out',
            );
        },
    };
}
