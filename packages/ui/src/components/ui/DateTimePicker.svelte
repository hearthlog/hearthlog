<script lang="ts">
    import DatePicker from "./DatePicker.svelte";

    let {
        value = $bindable(""),
        placeholder = "Choose date and time",
        ...restProps
    } = $props();
</script>

<DatePicker
    bind:value
    {placeholder}
    granularity="minute"
    {...restProps}
/>
