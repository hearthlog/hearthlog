<script lang="ts">
    import Modal from '@hearthlog/ui/components/Modal.svelte';
    import { submitHint } from '@hearthlog/ui/components/overlay-keys.js';
    import { enabledSectionShortcuts } from './shortcuts.js';

    let { show = false, onClose = () => {} }: { show?: boolean; onClose?: () => void } = $props();

    const apple = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const undoKey = apple ? '⌘Z' : 'Ctrl Z';
    const sections = enabledSectionShortcuts();

    interface ShortcutRow {
        label: string;
        keys: string[];
        chord?: boolean;
    }

    const groups: { title: string; items: ShortcutRow[] }[] = [
        ...(sections.length
            ? [{
                title: 'Navigation',
                items: sections.map((entry) => ({
                    label: `Go to ${entry.label}`,
                    keys: ['G', entry.key],
                    chord: true,
                })),
            }]
            : []),
        {
            title: 'Page & time',
            items: [
                { label: 'New item on this page', keys: ['N'] },
                { label: 'Previous / next period', keys: ['←', '→'] },
                { label: 'Jump to today', keys: ['T'] },
            ],
        },
        {
            title: 'Editing & sheets',
            items: [
                { label: 'Save or confirm active sheet', keys: [submitHint] },
                { label: 'Close open sheet or dialog', keys: ['Esc'] },
                { label: 'Undo last change', keys: [undoKey] },
            ],
        },
        {
            title: 'Shell',
            items: [
                { label: 'Collapse or expand sidebar', keys: ['['] },
                { label: 'Show keyboard shortcuts', keys: ['?'] },
            ],
        },
    ];
</script>

<Modal {show} title="Keyboard shortcuts" {onClose}>
    <div class="space-y-5">
        {#each groups as group}
            <section aria-label={group.title}>
                <h3 class="stor-overline mb-2">{group.title}</h3>
                <dl class="divide-y divide-[var(--stor-rule)]">
                    {#each group.items as item}
                        <div class="flex items-center justify-between gap-4 py-2 text-body">
                            <dt class="text-[var(--stor-ink)]">{item.label}</dt>
                            <dd class="flex shrink-0 items-center gap-1">
                                {#each item.keys as key, index}
                                    {#if index > 0}
                                        <span class="text-caption text-[var(--stor-faint-text)]" aria-hidden="true">{item.chord ? 'then' : '/'}</span>
                                    {/if}
                                    <kbd class="stor-kbd">{key}</kbd>
                                {/each}
                            </dd>
                        </div>
                    {/each}
                </dl>
            </section>
        {/each}
    </div>
</Modal>
