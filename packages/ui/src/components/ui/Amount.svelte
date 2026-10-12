<script lang="ts">
    import { formatAmount, type AmountOptions } from '../../utils/number-format.js';

    let {
        value,
        unit = 'Kč',
        signed = false,
        decimals = 'auto',
    }: {
        value: number;
        unit?: string;
        signed?: AmountOptions['signed'];
        decimals?: AmountOptions['decimals'];
    } = $props();
</script>

<span class="tabular-nums">{formatAmount(value, { signed, decimals })}</span>{' '}<span class="stor-unit">{unit}</span>
