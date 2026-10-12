import { createStandardRepositories } from '#generated/standard-db';
import type { ReadModelSession } from './read-session.js';
import { runActiveRead } from '../runtime/read-coordinator.js';
import { createCalendarRepository } from './calendar.js';
import { createEntityRepository } from './entities.js';
import { createHistoryRepository } from './history.js';
import { createModuleRepositories } from '#generated/module-repositories';

function createReadRepositories(session: ReadModelSession) {
    return {
        records: createStandardRepositories(session),
        ...createModuleRepositories(session),
        calendar: createCalendarRepository(session),
        history: createHistoryRepository(session),
        entities: createEntityRepository(session),
    };
}

export type ReadRepositories = ReturnType<typeof createReadRepositories>;

/**
 * Executes ordinary application reads against the currently active database view.
 * Schema selection, snapshot leasing, and tenant/log scoping stay inside the data layer.
 */
export function queryDatabase<T>(
    callback: (repositories: ReadRepositories) => Promise<T>,
): Promise<T> {
    return runActiveRead((session) => callback(createReadRepositories(session)));
}
