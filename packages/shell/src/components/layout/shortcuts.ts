import { FEATURES, featureForPath } from '@hearthlog/contracts/features/registry';
import { isFeatureEnabled } from '@hearthlog/contracts/tenant/config';
import { activeTimeNavigation } from '@hearthlog/ui/state/time-navigation.js';
import { lastChange } from './last-change.svelte.js';

/** G, then one of these, goes to the section with that nav label (Health's feature id is `bmi`, so ids will not do). */
const GO_KEYS: Record<string, string> = { f: 'Finance', h: 'Health', c: 'Calendar', i: 'Invoices' };
const GO_WINDOW_MS = 1500;

/** Keys that belong to what is focused: typing, menus, and anything with its own arrow handling. */
function takesKeys(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return target.isContentEditable || Boolean(target.closest('input, textarea, select, [role="textbox"], [role="combobox"], [role="listbox"], [role="menu"], [role="slider"], [role="tablist"], [role="grid"]'));
}

/**
 * The shell's keyboard shortcuts: N new item on this page (a visible `data-stor-new` button, else the feature's create shortcut), ← / → and T through time, G then F, H, C or I to go to
 * a section, ⌘Z to undo the last change. Esc is each sheet's own. Nothing fires while typing, while a sheet or
 * menu is open, or with a modifier other than ⌘/Ctrl on Z. Every shortcut also has a visible control.
 */
export function installShortcuts(goto: (href: string) => unknown): () => void {
    let goPending = 0;

    const handle = (event: KeyboardEvent) => {
        if (event.defaultPrevented || event.isComposing || event.repeat || takesKeys(event.target)) return;
        const key = event.key.toLowerCase();

        if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && key === 'z') {
            if (lastChange.current?.state === 'saved' && lastChange.current.reversal) {
                event.preventDefault();
                void lastChange.undo();
            }
            return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-state="open"][role="listbox"]')) return;

        if (goPending && Date.now() < goPending) {
            goPending = 0;
            const feature = FEATURES.find((entry) => entry.page?.label === GO_KEYS[key]);
            if (feature?.page && isFeatureEnabled(feature.id)) {
                event.preventDefault();
                void goto(feature.page.path);
            }
            return;
        }
        goPending = 0;

        if (key === 'g' && !event.shiftKey) {
            goPending = Date.now() + GO_WINDOW_MS;
        } else if (key === 'n' && !event.shiftKey) {
            // A page's own "new" button (marked `data-stor-new`) wins; else the feature's first create shortcut.
            const button = [...document.querySelectorAll<HTMLButtonElement>('button[data-stor-new]')].find((candidate) => !candidate.disabled && candidate.offsetParent !== null);
            if (button) {
                event.preventDefault();
                button.click();
                return;
            }
            const feature = featureForPath(window.location.pathname);
            const command = feature?.commands[0];
            if (feature?.page && command) {
                event.preventDefault();
                void goto(command.href ?? `${feature.page.path}${command.query ?? ''}`);
            }
        } else if (key === 't' || key === 'arrowleft' || key === 'arrowright') {
            const navigation = activeTimeNavigation();
            if (!navigation) return;
            event.preventDefault();
            if (key === 't') navigation.today();
            else if (key === 'arrowleft') navigation.previous();
            else navigation.next();
        }
    };

    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
}
