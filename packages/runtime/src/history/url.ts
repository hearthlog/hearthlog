// `historyLimit` and `historySide` are no longer read; they stay listed so closing the panel clears old links.
export const HISTORY_PARAMS = ['logPanel', 'historyAction', 'historyVersion', 'historySearch', 'historyFeature', 'historyLimit', 'historyStep', 'historySide', 'hiddenLogs'] as const;

export function historyUrlState(url: URL) {
    const version = Number(url.searchParams.get('historyVersion'));
    const step = url.searchParams.get('historyStep');
    return {
        tab: url.searchParams.get('logPanel') === 'logs' ? 'logs' : 'history',
        /** The action opened in place. */
        action: url.searchParams.get('historyAction'),
        version: Number.isSafeInteger(version) && version > 0 ? version : null,
        search: url.searchParams.get('historySearch') ?? '',
        feature: url.searchParams.get('historyFeature') ?? '',
        /** `fork` starts a log after the opened action; `copy` after the latest one. */
        step: step === 'review' || step === 'fork' ? 'fork' : step === 'copy' ? 'copy' : null,
        showHidden: url.searchParams.get('hiddenLogs') === '1',
    } as const;
}
