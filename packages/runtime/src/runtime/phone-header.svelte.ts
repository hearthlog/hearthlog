import type { Snippet } from 'svelte';

/**
 * What the page puts in the phone top bar (below 768 px): one glance figure
 * that opens the page's summary sheet, an optional context line such as the
 * day in view, and whether the bar needs the log button's room. The shell
 * owns the bar; `PhoneGlance` fills these while its page is mounted.
 */
class PhoneHeader {
    glance = $state<Snippet | null>(null);
    context = $state<string | null>(null);
    hideLog = $state(false);
    /** While rows are being selected the bar names the count and offers Select all and Cancel. */
    selection = $state<{ label: string; onSelectAll?: () => void; onCancel: () => void } | null>(null);
}

export const phoneHeader = new PhoneHeader();
