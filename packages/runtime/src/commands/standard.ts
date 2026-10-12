import { executeLocalCommand, type LocalCommandOptions } from './index.js';
import type { AppEvent } from '../event/types.js';

/** Typed convenience around the existing command boundary; no separate write path. */
export function standardCommand<T extends AppEvent['type']>(type: T) {
    return (payload: Extract<AppEvent, { type: T }>['payload'], options?: LocalCommandOptions) =>
        executeLocalCommand({ id: crypto.randomUUID(), type, timestamp: Date.now(), payload } as AppEvent, options);
}
