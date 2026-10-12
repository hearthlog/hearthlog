/**
 * File lifecycle for forks: which stored objects a child log must carry.
 *
 * The host asks every contributor (the modules that add some through
 * `ServerModule.forkFiles`, such as Invoices) for the files its inherited events
 * reference, merges them, and copies them. A fork cannot finish while a
 * required file is missing. Modules whose files are keyed by app rather than
 * log (Gallery) have nothing to copy: every log of the app already sees them.
 */

import type { FileContributor, ForkFile, ForkHistoryEvent } from '@hearthlog/contracts';

export type ForkScope = { appId: string; sourceLogId: string; childLogId: string };

/** Every contributor's files, with a file that two of them name made required if either requires it. */
export function planForkFiles(
    contributors: readonly FileContributor[],
    events: readonly ForkHistoryEvent[],
    scope: ForkScope,
): ForkFile[] {
    const files = new Map<string, ForkFile>();
    for (const contribute of contributors) {
        for (const file of contribute(events, scope)) {
            const key = `${file.bucket}:${file.sourceKey}`;
            const prior = files.get(key);
            files.set(key, { ...file, required: file.required || Boolean(prior?.required) });
        }
    }
    return [...files.values()];
}
