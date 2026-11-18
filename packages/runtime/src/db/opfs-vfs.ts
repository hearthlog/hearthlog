/**
 * Which SQLite OPFS VFS this browser gets.
 *
 * `opfs-wl` locks the database with Web Locks, which fixes the multi-tab contention the plain `opfs` VFS shows. It is
 * only safe on Chromium: in WebKit (Safari, iOS PWAs, and every iOS browser) a second connection waiting on an
 * `opfs-wl` lock can hang forever, even with a busy timeout. Safari exposes every API `opfs-wl` checks for, so a
 * feature check cannot tell; `navigator.userAgentData`, which only Chromium-based browsers expose (not Chrome on iOS),
 * can. Firefox keeps `opfs` until `opfs-wl` has been tested there.
 */
export type OpfsVfs = 'opfs' | 'opfs-wl';

interface UserAgentBrand {
    readonly brand: string;
    readonly version?: string;
}

interface NavigatorWithUserAgentData {
    readonly userAgentData?: { readonly brands?: ReadonlyArray<UserAgentBrand> };
}

export function preferredOpfsVfs(nav: NavigatorWithUserAgentData | undefined = globalThis.navigator as NavigatorWithUserAgentData | undefined): OpfsVfs {
    const brands = nav?.userAgentData?.brands ?? [];
    return brands.some(({ brand }) => brand === 'Chromium') ? 'opfs-wl' : 'opfs';
}

/** The engine `preferredOpfsVfs` saw, for the developer page: "Chromium (Google Chrome 142)" or why it is not. */
export function describeVfsChoice(nav: NavigatorWithUserAgentData | undefined = globalThis.navigator as NavigatorWithUserAgentData | undefined): string {
    const brands = nav?.userAgentData?.brands;
    if (!brands) return 'not Chromium (the browser does not report userAgentData: Safari, iOS or Firefox)';
    if (!brands.some(({ brand }) => brand === 'Chromium')) return 'not Chromium (userAgentData does not name Chromium)';
    const named = brands.find(({ brand }) => brand !== 'Chromium' && !/not.?a.?brand/i.test(brand));
    return named ? `Chromium (${named.brand}${named.version ? ` ${named.version}` : ''})` : 'Chromium';
}
