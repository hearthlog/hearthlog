/** Module API v0: the shared design system components. */
export { default as PageHeader } from '@hearthlog/ui/components/PageHeader.svelte';
export { default as PageDataStatus } from '@hearthlog/shell/components/layout/PageDataStatus.svelte';
export { default as DataValue } from '@hearthlog/ui/components/data/DataValue.svelte';
export { default as RouteTabs } from '@hearthlog/ui/components/ui/RouteTabs.svelte';
export { default as Panel } from '@hearthlog/ui/components/ui/Panel.svelte';
export { default as Field } from '@hearthlog/ui/components/ui/Field.svelte';
export { default as Input } from '@hearthlog/ui/components/ui/Input.svelte';
export { default as Select } from '@hearthlog/ui/components/ui/Select.svelte';
export { default as DatePicker } from '@hearthlog/ui/components/ui/DatePicker.svelte';
export { default as Checkbox } from '@hearthlog/ui/components/ui/Checkbox.svelte';
export { default as Metric } from '@hearthlog/ui/components/ui/Metric.svelte';
export { default as Badge } from '@hearthlog/ui/components/ui/Badge.svelte';
export { default as Amount } from '@hearthlog/ui/components/ui/Amount.svelte';
export { default as Button } from '@hearthlog/ui/components/ui/Button.svelte';
export { default as ChoiceChips } from '@hearthlog/ui/components/ui/ChoiceChips.svelte';
export { default as CollectionToolbar } from '@hearthlog/ui/components/ui/CollectionToolbar.svelte';
export { default as DateTimePicker } from '@hearthlog/ui/components/ui/DateTimePicker.svelte';
export { default as FoldLine } from '@hearthlog/ui/components/ui/FoldLine.svelte';
export { default as Switch } from '@hearthlog/ui/components/ui/Switch.svelte';
export { default as Textarea } from '@hearthlog/ui/components/ui/Textarea.svelte';
export { default as EmptyState } from '@hearthlog/ui/components/EmptyState.svelte';
export { default as Modal } from '@hearthlog/ui/components/Modal.svelte';
export { default as MobilePageAction } from '@hearthlog/shell/components/layout/MobilePageAction.svelte';
export { default as PhoneGlance } from '@hearthlog/shell/components/layout/PhoneGlance.svelte';
export { default as DataPlaceholder } from '@hearthlog/ui/components/data/DataPlaceholder.svelte';
export { default as CommandConfirmDialog } from '@hearthlog/ui/components/commands/CommandConfirmDialog.svelte';
export { default as CommandDrawer } from '@hearthlog/ui/components/commands/CommandDrawer.svelte';
export { default as CommandModal } from '@hearthlog/ui/components/commands/CommandModal.svelte';
export { default as CommandOnly } from '@hearthlog/ui/components/commands/CommandOnly.svelte';
export { tabIndicator } from '@hearthlog/ui/components/ui/tab-indicator.js';
export { default as Drawer } from '@hearthlog/ui/components/Drawer.svelte';
export { default as MonthNavigator } from '@hearthlog/ui/components/ui/MonthNavigator.svelte';
export { default as Label } from '@hearthlog/ui/components/ui/Label.svelte';
export { default as SyncStateBadge } from '@hearthlog/shell/components/sync/SyncStateBadge.svelte';
export { default as SuggestButton } from '@hearthlog/shell/components/ai/SuggestButton.svelte';
export { default as SuggestionChip } from '@hearthlog/shell/components/ai/SuggestionChip.svelte';
export { default as SuggestionMark } from '@hearthlog/shell/components/ai/SuggestionMark.svelte';
// The select's option type lives in the component's module script, which tsc cannot read; Svelte erases it.
// @ts-expect-error tsc sees only a default export from a .svelte file
export type { SelectOption } from '@hearthlog/ui/components/ui/Select.svelte';
export { default as DecisionReviewSheet } from '@hearthlog/shell/components/ai/DecisionReviewSheet.svelte';
// @ts-expect-error tsc sees only a default export from a .svelte file
export type { ReviewItem } from '@hearthlog/shell/components/ai/DecisionReviewSheet.svelte';
export { cn } from '@hearthlog/ui/utils/cn.js';
