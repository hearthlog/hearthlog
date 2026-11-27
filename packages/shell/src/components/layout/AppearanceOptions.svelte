<script lang="ts">
    import { appearance } from "@hearthlog/runtime/theme/appearance.svelte.js";
    import type { ThemePreference } from "@hearthlog/contracts/tenant/theme";
    import { tabIndicator } from "@hearthlog/ui/components/ui/tab-indicator.js";
    import IconDesktop from "~icons/mdi/monitor";
    import IconLight from "~icons/mdi/white-balance-sunny";
    import IconDark from "~icons/mdi/weather-night";

    let { compact = false }: { compact?: boolean } = $props();

    const options: {
        value: ThemePreference;
        label: string;
        description: string;
        icon: typeof IconDesktop;
    }[] = [
        { value: "system", label: "System", description: "Match this device", icon: IconDesktop },
        { value: "light", label: "Light", description: "Always use light mode", icon: IconLight },
        { value: "dark", label: "Dark", description: "Always use dark mode", icon: IconDark },
    ];
</script>

{#if compact}
<fieldset class="stor-segmented-control grid grid-cols-3 gap-1 rounded-xl p-1" aria-label="Appearance" {@attach tabIndicator}>
    <legend class="sr-only">Appearance</legend>
    {#each options as option}
        {@const Icon = option.icon}
        {@const selected = appearance.preference === option.value}
        <label
            data-checked={selected ? "true" : undefined}
            class="stor-segmented-option flex min-h-11 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-xs font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--stor-focus)] sm:min-h-14"
        >
            <input
                class="sr-only"
                type="radio"
                name="stor-appearance-compact"
                value={option.value}
                checked={selected}
                onchange={() => appearance.setPreference(option.value)}
            />
            <Icon class="h-4 w-4" />
            <span>{option.label}</span>
        </label>
    {/each}
</fieldset>
{:else}
<fieldset class="grid gap-1" aria-label="Appearance">
    <legend class="sr-only">Appearance</legend>
    {#each options as option}
        {@const Icon = option.icon}
        <label
            class="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-left transition hover:bg-[var(--stor-surface-hover)]"
            class:bg-[var(--stor-selected)]={appearance.preference === option.value}
        >
            <input
                class="sr-only"
                type="radio"
                name="stor-appearance"
                value={option.value}
                checked={appearance.preference === option.value}
                onchange={() => appearance.setPreference(option.value)}
            />
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--stor-surface-raised)] text-[var(--stor-accent-strong)] shadow-[var(--stor-elevation-2)]">
                <Icon class="h-4 w-4" />
            </span>
            <span class="min-w-0">
                <span class="block text-sm font-semibold text-[var(--stor-ink)]">{option.label}</span>
                <span class="block text-xs text-[var(--stor-muted-text)]">{option.description}</span>
            </span>
            <span
                class="ml-auto h-2.5 w-2.5 rounded-full border border-[var(--stor-field-border)]"
                class:bg-[var(--stor-action)]={appearance.preference === option.value}
                aria-hidden="true"
            ></span>
        </label>
    {/each}
</fieldset>
{/if}
