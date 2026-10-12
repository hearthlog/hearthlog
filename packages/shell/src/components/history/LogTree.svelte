<script lang="ts">
    import type { LogNode } from '@hearthlog/runtime/history/lineage.js';
    import { ownChanges } from '@hearthlog/runtime/history/lineage.js';
    import { formatLogDay } from '@hearthlog/runtime/history/log-format.js';
    import { formatNumber } from '@hearthlog/ui/utils/number-format.js';
    import IconCheck from '~icons/mdi/check';
    import IconEyeOff from '~icons/mdi/eye-off-outline';
    import IconEye from '~icons/mdi/eye-outline';

    let {
        nodes,
        currentLogId,
        switchingLogId = null,
        busyLogId = null,
        hideDisabledReason,
        onOpen,
        onHide,
    }: {
        nodes: LogNode[];
        currentLogId: string | null;
        switchingLogId?: string | null;
        busyLogId?: string | null;
        /** Why hiding is unavailable, such as being offline. */
        hideDisabledReason?: string;
        onOpen: (logId: string) => void;
        onHide: (logId: string, hidden: boolean) => void;
    } = $props();

    // From the fourth level down, logs stop indenting; their meta line names the source.
    const FLAT_DEPTH = 3;

    function meta(node: LogNode): string {
        const log = node.log;
        const parts: string[] = [];
        if (log.hiddenAt) parts.push('Hidden');
        if (log.sourceLogId) {
            parts.push(`from ${log.sourceLogName ?? 'another log'}`);
            const forked = formatLogDay(log.sourceTimestamp ?? log.createdAt);
            if (forked) parts.push(forked);
            if (log.status === 'preparing') {
                parts.push('preparing its files');
            } else {
                const own = ownChanges(log);
                parts.push(own === 0 ? 'no changes of its own' : `${formatNumber(own)} own ${own === 1 ? 'change' : 'changes'}`);
                if (own > 0 && log.lastUpdatedAt) parts.push(formatLogDay(log.lastUpdatedAt));
            }
        } else if (log.headVersion === 0) {
            parts.push('Empty');
            const created = formatLogDay(log.createdAt);
            if (created) parts.push(`created ${created}`);
        } else {
            parts.push(`${formatNumber(log.headVersion)} ${log.headVersion === 1 ? 'change' : 'changes'}`);
            if (log.lastUpdatedAt) parts.push(`last change ${formatLogDay(log.lastUpdatedAt)}`);
        }
        return parts.join(' · ');
    }
</script>

{#snippet branch(items: LogNode[], depth: number)}
    <ul class="log-tree" class:nested={depth > 0 && depth <= FLAT_DEPTH}>
        {#each items as node (node.log.id)}
            {@const log = node.log}
            {@const current = log.id === currentLogId}
            <li>
                <div class="flex items-start gap-1">
                    <button
                        type="button"
                        class="flex min-h-12 min-w-0 flex-1 items-start gap-3 rounded-xl px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] disabled:cursor-default {current
                            ? 'bg-[var(--stor-surface-raised)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--stor-border)_70%,transparent),0_1px_3px_rgb(16_42_67/0.07)]'
                            : 'hover:bg-[var(--stor-surface-hover)]'} {log.hiddenAt ? 'opacity-70' : ''}"
                        aria-current={current ? 'true' : undefined}
                        aria-label={current ? `${log.name}, current log` : log.status === 'preparing' ? `${log.name}, preparing` : `Open ${log.name}`}
                        disabled={current || log.status === 'preparing' || switchingLogId !== null}
                        onclick={() => onOpen(log.id)}
                    >
                        <span class="min-w-0 flex-1">
                            <span class="block break-words text-sm font-semibold text-[var(--stor-ink)]">{log.name}</span>
                            <span class="mt-0.5 block break-words text-xs text-[var(--stor-muted-text)]">{meta(node)}</span>
                        </span>
                        {#if current}
                            <span class="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-semibold text-[var(--stor-ink)]"><IconCheck class="h-4 w-4" />Current</span>
                        {:else if log.status === 'preparing'}
                            <span class="mt-0.5 shrink-0 rounded-full bg-[var(--stor-info-soft)] px-2 py-0.5 text-xs font-medium text-[var(--stor-info)]">Preparing</span>
                        {:else if switchingLogId === log.id}
                            <span class="mt-0.5 shrink-0 text-xs text-[var(--stor-muted-text)]" role="status">Opening…</span>
                        {/if}
                    </button>
                    {#if !current && log.status !== 'preparing'}
                        <button
                            type="button"
                            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--stor-focus)] disabled:opacity-40 sm:h-9 sm:w-9"
                            aria-label={log.hiddenAt ? `Show ${log.name}` : `Hide ${log.name}`}
                            title={hideDisabledReason ?? (log.hiddenAt ? 'Show in the tree' : 'Hide from the tree')}
                            disabled={Boolean(hideDisabledReason) || busyLogId !== null}
                            onclick={() => onHide(log.id, !log.hiddenAt)}
                        >
                            {#if log.hiddenAt}<IconEye class="h-4 w-4" />{:else}<IconEyeOff class="h-4 w-4" />{/if}
                        </button>
                    {/if}
                </div>
                {#if node.children.length > 0}
                    {@render branch(node.children, depth + 1)}
                {/if}
            </li>
        {/each}
    </ul>
{/snippet}

<nav aria-label="Your logs">
    {@render branch(nodes, 0)}
</nav>

<style>
    .log-tree { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .log-tree.nested { position: relative; margin-top: 2px; padding-left: 22px; }
    .log-tree.nested > li { position: relative; }
    /* An elbow from the parent's line to each fork, and the line on to later siblings. */
    .log-tree.nested > li::before {
        content: ''; position: absolute; left: -12px; top: 0; width: 10px; height: 26px;
        border-left: 1.5px solid var(--stor-border); border-bottom: 1.5px solid var(--stor-border); border-bottom-left-radius: 8px;
    }
    .log-tree.nested > li::after { content: ''; position: absolute; left: -12px; top: 0; bottom: 0; border-left: 1.5px solid var(--stor-border); }
    .log-tree.nested > li:last-child::after { display: none; }
</style>
