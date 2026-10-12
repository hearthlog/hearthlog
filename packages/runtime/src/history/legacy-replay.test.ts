import { afterEach, expect, it } from 'vitest';
import { createLocalDatabase } from '../testing/local-database.js';
import { reconcileRestoredEvents, filterRestoredSnapshot } from './legacy-replay.js';
const clients: ReturnType<typeof createLocalDatabase>[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.database.destroy(); });
const scope = { tenantId: 'person', logId: 'personal' };
function fixture() {
    const client = createLocalDatabase(); clients.push(client);
    const insert = client.sqlite.prepare(`INSERT INTO raw_events
        (id,tenant_id,log_id,local_batch_id,local_sequence,type,timestamp,payload,log_version)
        VALUES (?, 'person', 'personal', 'batch', ?, ?, 1, ?, ?)`);
    insert.run('one', 1, 'CALENDAR_EVENT_ADDED', '{}', 1);
    insert.run('two', 2, 'CALENDAR_EVENT_UPDATED', '{}', 2);
    insert.run('restore', 3, 'WORKSPACE_RESTORED', '{"targetVersion":1}', 3);
    return { ...client, insert };
}
it('uses identical selection for live rebuild and isolated historical snapshots', async () => {
    const c = fixture();
    await reconcileRestoredEvents(c.database, scope);
    expect(c.sqlite.prepare("SELECT id FROM raw_events WHERE projection_state='effective' ORDER BY log_version").all())
        .toEqual([{ id: 'one' }, { id: 'restore' }]);
    c.sqlite.exec('CREATE TEMP TABLE snapshot AS SELECT * FROM raw_events');
    await filterRestoredSnapshot(c.database, 'temp.snapshot', 3);
    expect(c.sqlite.prepare('SELECT id FROM snapshot ORDER BY log_version').all()).toEqual([{ id: 'one' }, { id: 'restore' }]);
    expect(c.sqlite.prepare('SELECT COUNT(*) AS count FROM raw_events').get()).toEqual({ count: 3 });
});
it('defers restore across a download gap and recovers when it arrives', async () => {
    const c = fixture(); c.sqlite.exec("DELETE FROM raw_events WHERE id='two'");
    await reconcileRestoredEvents(c.database, scope);
    expect(c.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='restore'").get()).toEqual({ projection_state: 'restored_out' });
    c.insert.run('two', 2, 'CALENDAR_EVENT_UPDATED', '{}', 2);
    await reconcileRestoredEvents(c.database, scope);
    expect(c.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='restore'").get()).toEqual({ projection_state: 'effective' });
});
it('keeps undone pending actions uploadable and includes a durable pending restore undo', async () => {
    const c = fixture();
    c.insert.run('pending', 4, 'CALENDAR_EVENT_UPDATED', '{}', null);
    c.insert.run('undo-pending', 5, 'EVENT_TOMBSTONED', '{"eventId":"pending"}', null);
    await reconcileRestoredEvents(c.database, scope);
    expect(c.sqlite.prepare("SELECT projection_state,is_tombstoned FROM raw_events WHERE id='pending'").get())
        .toEqual({ projection_state: 'effective', is_tombstoned: 1 });
    c.insert.run('undo-restore', 6, 'EVENT_TOMBSTONED', '{"eventId":"restore"}', null);
    c.sqlite.exec("UPDATE raw_events SET projection_state='pending_ddl' WHERE id='undo-restore'");
    await reconcileRestoredEvents(c.database, scope, true);
    expect(c.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='two'").get()).toEqual({ projection_state: 'effective' });
    expect(c.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='undo-restore'").get()).toEqual({ projection_state: 'pending_ddl' });
});
