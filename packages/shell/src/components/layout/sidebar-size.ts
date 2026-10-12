// Pure size rules for the resizable desktop sidebar. app.template.html repeats the clamp in its boot script.
export const SIDEBAR_RAIL_WIDTH = 80;
export const SIDEBAR_MIN_WIDTH = 192;
export const SIDEBAR_DEFAULT_WIDTH = 224;
export const SIDEBAR_MAX_WIDTH = 336;
/** Halfway between the rail and the minimum: dragging narrower than this folds the sidebar. */
export const SIDEBAR_FOLD_WIDTH = 136;
/** A drag within this many pixels of the default width lands on it exactly. */
export const SIDEBAR_SNAP_RANGE = 8;
export const SIDEBAR_KEY_STEP = 16;
export const SIDEBAR_WIDTH_KEY = 'stor:sidebar-width';

export function clampSidebarWidth(width: number): number {
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

/** Where a drag ends up for a requested width; `width` is null when the drag folds the sidebar. */
export function resolveSidebarDrag(width: number): { folded: boolean; width: number | null } {
    if (width < SIDEBAR_FOLD_WIDTH) return { folded: true, width: null };
    const snapped = Math.abs(width - SIDEBAR_DEFAULT_WIDTH) <= SIDEBAR_SNAP_RANGE ? SIDEBAR_DEFAULT_WIDTH : width;
    return { folded: false, width: clampSidebarWidth(snapped) };
}

export function readSidebarWidth(storage: Pick<Storage, 'getItem'>): number {
    try {
        const value = Number(storage.getItem(SIDEBAR_WIDTH_KEY));
        return Number.isFinite(value) && value > 0 ? clampSidebarWidth(value) : SIDEBAR_DEFAULT_WIDTH;
    } catch {
        return SIDEBAR_DEFAULT_WIDTH;
    }
}
