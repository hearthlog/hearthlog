/**
 * Press and hold on touch: calls `onLongPress` with the element matching
 * `selector` after `delay` ms unless the finger moved more than 8 px, then
 * swallows the click that follows so the press does not also open the row.
 * A mouse never long-presses; desktop rows keep their checkboxes.
 */
export function longPress(
    node: HTMLElement,
    options: { selector: string; onLongPress: (element: HTMLElement) => void; delay?: number },
) {
    let current = options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start = { x: 0, y: 0 };
    let fired = false;

    const cancel = () => clearTimeout(timer);

    function down(event: PointerEvent): void {
        if (event.pointerType === 'mouse') return;
        const target = (event.target as HTMLElement).closest<HTMLElement>(current.selector);
        if (!target || !node.contains(target)) return;
        fired = false;
        start = { x: event.clientX, y: event.clientY };
        cancel();
        timer = setTimeout(() => {
            fired = true;
            // A press that never ends in a click (the finger slid off) must not eat a later tap.
            setTimeout(() => { fired = false; }, 800);
            navigator.vibrate?.(10);
            current.onLongPress(target);
        }, current.delay ?? 450);
    }

    function move(event: PointerEvent): void {
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) cancel();
    }

    function click(event: MouseEvent): void {
        if (!fired) return;
        fired = false;
        event.preventDefault();
        event.stopPropagation();
    }

    function contextMenu(event: Event): void {
        if ((event.target as HTMLElement).closest(current.selector)) event.preventDefault();
    }

    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', cancel);
    node.addEventListener('pointercancel', cancel);
    node.addEventListener('scroll', cancel, true);
    node.addEventListener('click', click, true);
    node.addEventListener('contextmenu', contextMenu);

    return {
        update(next: typeof options) { current = next; },
        destroy() {
            cancel();
            node.removeEventListener('pointerdown', down);
            node.removeEventListener('pointermove', move);
            node.removeEventListener('pointerup', cancel);
            node.removeEventListener('pointercancel', cancel);
            node.removeEventListener('scroll', cancel, true);
            node.removeEventListener('click', click, true);
            node.removeEventListener('contextmenu', contextMenu);
        },
    };
}
