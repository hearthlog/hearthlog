import { SQL_EXPORT_BOUNDARY, SQL_EXPORT_COMPLETE } from "@hearthlog/contracts/ledger/admin";

// The markers are the wire format shared with the browser's export worker.
export { SQL_EXPORT_BOUNDARY, SQL_EXPORT_COMPLETE };

interface SchemaRow extends Record<string, SqlStorageValue> {
    name: string;
    type: string;
    sql: string;
}

/** A complete export of Ledger-owned SQL tables; never reads platform internals. */
export function sqliteExport(
    storage: DurableObjectStorage,
    filename: string,
): Response {
    const sql = storage.sql;
    // SQLite's connection-wide counter includes rolled-back writes. Rejecting
    // those conservatively is preferable to returning a mixed-time backup.
    const changes = () =>
        sql.exec<{ count: number }>("SELECT total_changes() AS count").one()
            .count;
    const initialChanges = changes();
    const readSchema = () =>
        sql
            .exec<SchemaRow>(
                `SELECT name, type, sql FROM sqlite_schema
         WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
         ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
            )
            .toArray();
    const schema = readSchema();
    const tables = schema
        .filter((item) => item.type === "table")
        .map((table) => {
            // Ledger's tables all have rowids. Fail rather than silently omit data
            // if a future schema introduces a different table storage model.
            sql.exec(
                `SELECT rowid FROM ${identifier(table.name)} LIMIT 0`,
            ).toArray();
            const columns = sql
                .exec<{ name: string; hidden: number }>(
                    `PRAGMA table_xinfo(${identifier(table.name)})`,
                )
                .toArray()
                .filter((column) => column.hidden === 0)
                .map((column) => column.name);
            const values = columns
                .map((name) => {
                    const column = identifier(name);
                    // Hex text preserves NULs, quotes and Unicode; SQLite quote(TEXT)
                    // alone truncates at the first NUL. SQL formats numeric values so
                    // 64-bit integers never pass through JavaScript numbers.
                    return `CASE typeof(${column}) WHEN 'text' THEN 'CAST(X''' || hex(${column}) || ''' AS TEXT)' ELSE quote(${column}) END`;
                })
                .join(" || ',' || ");
            const insert = `INSERT INTO ${identifier(table.name)} (${columns.map(identifier).join(",")}) VALUES (`;
            return {
                ...table,
                query: `SELECT CAST(rowid AS TEXT) AS cursor, ${literal(insert)} || ${values} || ');' AS statement FROM ${identifier(table.name)}`,
            };
        });
    function* statements(): Generator<string> {
        yield `-- Ledger SQL export ${new Date().toISOString()}\n-- All Ledger-owned tables, schema and indexes. Platform KV/PITR state is excluded.\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;`;
        for (const table of tables) {
            yield table.sql + ";";
            let cursor: string | null = null;
            while (true) {
                // Consume each SQL cursor synchronously. No cursor survives a
                // stream pull, and every pull checks that no write interleaved.
                const rows: { cursor: string; statement: string }[] = sql
                    .exec<{ cursor: string; statement: string }>(
                        table.query +
                            (cursor === null
                                ? ""
                                : " WHERE rowid > CAST(? AS INTEGER)") +
                            " ORDER BY rowid LIMIT 8",
                        ...(cursor === null ? [] : [cursor]),
                    )
                    .toArray();
                for (const row of rows) yield row.statement;
                if (rows.length < 8) break;
                cursor = rows.at(-1)!.cursor;
            }
        }
        for (const item of schema.filter((item) => item.type !== "table"))
            yield item.sql + ";";
        if (JSON.stringify(readSchema()) !== JSON.stringify(schema))
            throw new Error(
                "Database schema changed during export. Retry the download.",
            );
        yield "COMMIT;\n" + SQL_EXPORT_COMPLETE;
    }
    const iterator = statements();
    const encoder = new TextEncoder();
    return new Response(
        new ReadableStream<Uint8Array>({
            pull(controller) {
                if (changes() !== initialChanges) {
                    iterator.return(undefined);
                    controller.error(
                        new Error(
                            "Database changed during export. Retry when application writes have stopped.",
                        ),
                    );
                    return;
                }
                const result = iterator.next();
                if (result.done) controller.close();
                else
                    controller.enqueue(
                        encoder.encode(result.value + SQL_EXPORT_BOUNDARY),
                    );
            },
            cancel() {
                iterator.return(undefined);
            },
        }),
        {
            headers: {
                "Content-Type": "application/sql; charset=utf-8",
                "Content-Disposition": `attachment; filename="${filename}.sql"`,
                "Cache-Control": "no-store",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "X-Content-Type-Options": "nosniff",
            },
        },
    );
}

function identifier(value: string): string {
    return '"' + value.replaceAll('"', '""') + '"';
}
function literal(value: string): string {
    return "'" + value.replaceAll("'", "''") + "'";
}
