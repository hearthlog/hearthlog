import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The type scale's `text-<name>` sizes (base.css `@theme`), so a colour class after one never drops it. */
const twMerge = extendTailwindMerge({
    extend: {
        theme: {
            text: ["display", "title-1", "title-2", "title-3", "body", "small", "caption", "overline"],
        },
    },
});

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}
