import { cva } from "class-variance-authority";

/**
 * Flat faces: primary is the accent fill, secondary a raised surface with a 1px border, ghost borrows the
 * neutral hover surface (accent keeps meaning "selected"), and destructive is tonal. Focus is the global
 * 2px outline with a 2px gap; a press scales to 0.98. ConfirmDialog draws its actions from this recipe too.
 */
export const buttonVariants = cva(
    "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-[background-color,color,box-shadow,transform,filter] duration-[var(--stor-dur-1)] ease-out active:scale-[0.98] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-45 sm:rounded-[10px]",
    {
        variants: {
            variant: {
                default: "bg-[var(--stor-action)] text-[var(--stor-action-text)] hover:bg-[var(--stor-action-hover)] active:brightness-[.94]",
                secondary: "bg-[var(--stor-surface-raised)] text-[var(--stor-ink)] shadow-[0_0_0_1px_var(--stor-border-strong)] hover:bg-[var(--stor-surface-hover)]",
                ghost: "text-[var(--stor-muted-text)] hover:bg-[var(--stor-surface-hover)] hover:text-[var(--stor-ink)]",
                destructive: "bg-[var(--stor-negative-soft)] text-[var(--stor-negative)] hover:bg-[color-mix(in_srgb,var(--stor-negative)_8%,var(--stor-negative-soft))]",
            },
            size: {
                sm: "h-11 px-3 sm:h-9",
                md: "h-11 px-4.5 sm:h-9 sm:px-3.5",
                icon: "h-11 w-11 p-0 sm:h-9 sm:w-9",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "md",
        },
    },
);

/** The confirm dialog's destructive action: the one place a red fill is right. */
export const filledDestructive = "bg-[var(--stor-negative)] text-[var(--stor-negative-text)] hover:bg-[var(--stor-negative)] hover:brightness-90";

export const spinnerTone = {
    default: "text-[var(--stor-action-text)]",
    secondary: "text-[var(--stor-ink)]",
    ghost: "text-[var(--stor-muted-text)]",
    destructive: "text-[var(--stor-negative)]",
} as const;
