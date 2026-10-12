import { afterEach, expect, it, vi } from 'vitest';
import { createLocalDatabase } from '../testing/local-database.js';
const state = vi.hoisted(() => ({ database: null as unknown as ReturnType<typeof createLocalDatabase>['database'] }));
vi.mock('../db/index.js', () => ({ get db() { return state.database; }, requireActiveContext: async () => ({ tenantId: 'person', logId: 'personal' }) }));
vi.mock('../db/kv.js', () => ({ get() {}, set() {} }));
vi.mock('../ledger/version-tracker-singleton.js', () => ({ versionTracker: { async rebuildVersionCache() {} } }));
vi.mock('@hearthlog/contracts/tenant/config', () => ({ tenant: { dynamicEntities: true, approvedEntities: { entityNames: new Set(['calendar_event']) } } }));
import { rebuildReadModel } from './rebuild.js';
import { clearDynamicRegistry } from './registry.js';
afterEach(async () => { clearDynamicRegistry(); await state.database.destroy(); });

it('rolls back restore membership, dynamic definitions, and rows together, then retries', async () => {
    const c = createLocalDatabase(); state.database = c.database;
    c.sqlite.exec(`CREATE TABLE entity_type_definitions (
        tenant_id TEXT, log_id TEXT, id TEXT, name TEXT, display_name TEXT, table_name TEXT,
        fields_json TEXT, calendar_json TEXT, is_archived INTEGER, created_at TEXT, updated_at TEXT,
        PRIMARY KEY (tenant_id,log_id,id))`);
    const insert = c.sqlite.prepare(`INSERT INTO raw_events
        (id,tenant_id,log_id,local_batch_id,local_sequence,type,timestamp,payload,entity_id,entity_version,log_version,sync_state)
        VALUES (?, 'person','personal','accepted',?,?,?, ?,?,1,?,'synced')`);
    function append(version: number, type: string, entity: string, payload: unknown) {
        insert.run(`e${version}`, version, type, version * 1000, JSON.stringify(payload), entity, version);
    }
    append(1, 'CALENDAR_EVENT_ADDED', 'calendar_event:one', { id: 'one', title: 'Original', eventDate: '2026-10-12' });
    append(2, 'ENTITY_TYPE_DEFINED', 'entity_type:project', { id: 'project', name: 'project', displayName: 'Project', tableName: 'projects', fields: [{ name: 'name', type: 'string', payloadKey: 'name' }] });
    append(3, 'PROJECT_ADDED', 'project:one', { id: 'one', name: 'Project one' });
    append(4, 'CALENDAR_EVENT_UPDATED', 'calendar_event:one', { id: 'one', title: 'Changed' });
    await rebuildReadModel();
    append(5, 'WORKSPACE_RESTORED', 'workspace:state', { targetVersion: 1 });
    c.sqlite.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON calendar_events BEGIN SELECT RAISE(ABORT,'projection interrupted'); END");
    await expect(rebuildReadModel()).rejects.toThrow('projection interrupted');
    expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Changed' });
    expect(c.sqlite.prepare('SELECT name FROM entity_type_definitions').get()).toEqual({ name: 'project' });
    expect(c.sqlite.prepare('SELECT name FROM projects').get()).toEqual({ name: 'Project one' });
    expect(c.sqlite.prepare("SELECT projection_state FROM raw_events WHERE id='e4'").get()).toEqual({ projection_state: 'effective' });
    c.sqlite.exec('DROP TRIGGER reject_projection');
    await rebuildReadModel();
    expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Original' });
    expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM entity_type_definitions').get()).toEqual({ n: 0 });
    expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 0 });
    expect(c.sqlite.prepare('SELECT COUNT(*) AS n FROM raw_events').get()).toEqual({ n: 5 });
    // Another device can upload an edit authored before the restore. Acceptance
    // order decides the current value; the restored boundary stays available.
    append(6, 'CALENDAR_EVENT_UPDATED', 'calendar_event:one', { id: 'one', title: 'Late offline edit' });
    c.sqlite.exec("UPDATE raw_events SET timestamp=1,entity_version=3 WHERE id='e6'");
    await rebuildReadModel();
    expect(c.sqlite.prepare('SELECT title FROM calendar_events').get()).toEqual({ title: 'Late offline edit' });
    expect(c.sqlite.prepare("SELECT payload FROM raw_events WHERE id='e1'").get()).toEqual({ payload: JSON.stringify({ id: 'one', title: 'Original', eventDate: '2026-10-12' }) });
});
