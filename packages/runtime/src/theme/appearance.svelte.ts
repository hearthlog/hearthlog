import type { ResolvedTheme, ThemePreference } from "@hearthlog/contracts/tenant/theme";

export const APPEARANCE_EVENT = "stor:appearance-change";

export function appearanceStorageKey(tenantId: string): string {
    return `stor:appearance:${tenantId}`;
}

export function parseThemePreference(value: unknown): ThemePreference {
    return value === "light" || value === "dark" || value === "system"
        ? value
        : "system";
}

export function resolveTheme(
    preference: ThemePreference,
    systemPrefersDark: boolean,
): ResolvedTheme {
    return preference === "system"
        ? systemPrefersDark
            ? "dark"
            : "light"
        : preference;
}

function initialPreference(): ThemePreference {
    if (typeof document === "undefined") return "system";
    return parseThemePreference(document.documentElement.dataset.appearance);
}

function initialTheme(): ResolvedTheme {
    if (typeof document === "undefined") return "light";
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

let preference = $state<ThemePreference>(initialPreference());
let resolved = $state<ResolvedTheme>(initialTheme());
let storageKey = "";
let mediaQuery: MediaQueryList | null = null;
let removeListeners: (() => void) | null = null;
let switchFrame = 0;

function applyResolvedTheme(next: ResolvedTheme): void {
    const root = document.documentElement;
    const themeChanged = root.dataset.theme !== next;
    if (themeChanged) {
        if (switchFrame) cancelAnimationFrame(switchFrame);
        root.dataset.themeSwitching = "";
    }
    resolved = next;
    root.dataset.theme = next;
    root.dataset.appearance = preference;
    root.style.colorScheme = next;
    if (themeChanged) {
        // Keep transitions suppressed across the paint that flips the theme tokens, then restore them.
        switchFrame = requestAnimationFrame(() => {
            switchFrame = requestAnimationFrame(() => {
                switchFrame = 0;
                delete root.dataset.themeSwitching;
            });
        });
    }
    const themeColor = getComputedStyle(root)
        .getPropertyValue("--stor-theme-color")
        .trim();
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta && themeColor) meta.content = themeColor;
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, {
        detail: { preference, resolved: next },
    }));
}

function applyPreference(next: ThemePreference, persist: boolean): void {
    preference = next;
    if (persist && storageKey) {
        try {
            localStorage.setItem(storageKey, next);
        } catch {
            // The in-memory selection still works when storage is unavailable.
        }
    }
    applyResolvedTheme(resolveTheme(next, mediaQuery?.matches ?? false));
}

export function initializeAppearance(tenantId: string): () => void {
    removeListeners?.();
    storageKey = appearanceStorageKey(tenantId);
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    let stored: unknown = document.documentElement.dataset.appearance;
    try {
        stored = localStorage.getItem(storageKey);
    } catch {
        // Use the preference resolved by the boot script.
    }
    applyPreference(parseThemePreference(stored), false);

    const handleSystemChange = (event: MediaQueryListEvent) => {
        if (preference === "system") {
            applyResolvedTheme(event.matches ? "dark" : "light");
        }
    };
    const handleStorage = (event: StorageEvent) => {
        if (event.key === storageKey) {
            applyPreference(parseThemePreference(event.newValue), false);
        }
    };
    mediaQuery.addEventListener("change", handleSystemChange);
    window.addEventListener("storage", handleStorage);
    removeListeners = () => {
        mediaQuery?.removeEventListener("change", handleSystemChange);
        window.removeEventListener("storage", handleStorage);
        removeListeners = null;
    };
    return removeListeners;
}

export const appearance = {
    get preference(): ThemePreference {
        return preference;
    },
    get resolved(): ResolvedTheme {
        return resolved;
    },
    setPreference(next: ThemePreference): void {
        applyPreference(next, true);
    },
};
