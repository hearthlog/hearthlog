import { requireActiveContext } from '../db/index.js';
import { getAdjacentHistoryPoint, getHistoryPoint, type HistoryPoint } from './history.js';
import { readWorkspaceSnapshot } from './point-snapshot.js';
import { compareWorkspaceRecords, type HistoryChange } from './change-comparison.js';

export interface HistoryActionDetail {
    point: HistoryPoint;
    previousVersion: number;
    changes: HistoryChange[];
}

/** Compare only the selected accepted action boundary with its predecessor. */
export async function loadHistoryActionDetail(version: number): Promise<HistoryActionDetail> {
    const point = await getHistoryPoint(version);
    if (!point) throw new Error('That action is no longer available in this log.');
    const previous = await getAdjacentHistoryPoint(version, 'previous');
    const context = await requireActiveContext();
    const scope = { tenantId: context.tenantId, logId: context.logId };
    const previousVersion = previous?.version ?? 0;
    const before = await readWorkspaceSnapshot(previousVersion, scope);
    const after = await readWorkspaceSnapshot(point.version, scope);
    return { point, previousVersion, changes: compareWorkspaceRecords(before, after) };
}
