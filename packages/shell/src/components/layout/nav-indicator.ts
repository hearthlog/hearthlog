const SELECTED = 'a[data-nav-link][aria-current="page"]';

/** Smoothing constant: the pill covers 95% of the distance in about 280 ms, the same as `--stor-tab-motion`. */
const TIME_CONSTANT_MS = 93;

/** Keep following the row after a change, so the pill tracks sub-lists that are still opening or closing. */
const FOLLOW_MS = 320;

interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Position of `el` inside the positioned `nav`, read from layout offsets so scrolling and transforms do not matter. */
function boxIn(el: HTMLElement, nav: HTMLElement): Box {
    let x = 0;
    let y = 0;
    let node: HTMLElement | null = el;
    while (node && node !== nav) {
        x += node.offsetLeft;
        y += node.offsetTop;
        node = node.offsetParent as HTMLElement | null;
    }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

/**
 * Sliding selection pill for the sidebar navigation, the vertical sibling of
 * `tabIndicator`.
 *
 * Measures the selected top-level link (`a[data-nav-link]` with
 * `aria-current`), or the `[data-nav-section]` card around it in the expanded
 * sidebar, and glides a raised pill to it. The pill keeps following the row
 * while a sub-list opens or closes, so it lands on the row's resting position
 * and size rather than where the row was when the page changed. The selected
 * section keeps its own background until the pill is placed, and reduced
 * motion snaps.
 *
 * Usage: `{@attach navIndicator}` on the positioned `<nav>` that holds the links.
 */
export function navIndicator(nav: HTMLElement): () => void {
    const pill = document.createElement('span');
    pill.className = 'stor-nav-indicator';
    pill.setAttribute('aria-hidden', 'true');
    pill.setAttribute('role', 'presentation');
    nav.insertBefore(pill, nav.firstChild);

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let shown: Box | null = null;
    let frame = 0;
    let previous = 0;
    let followUntil = 0;
    let destroyed = false;

    const paint = (box: Box): void => {
        pill.style.width = `${box.w}px`;
        pill.style.height = `${box.h}px`;
        pill.style.transform = `translate(${box.x}px, ${box.y}px)`;
    };

    const step = (now: number): void => {
        frame = 0;
        if (destroyed) return;
        const selected = nav.querySelector<HTMLElement>(SELECTED);
        if (!selected || selected.offsetWidth === 0) {
            shown = null;
            nav.classList.remove('stor-nav-sliding');
            return;
        }
        // The expanded sidebar raises the whole section, so the pill wraps its open sub-pages too.
        const target = boxIn(selected.closest<HTMLElement>('[data-nav-section]') ?? selected, nav);
        if (!shown || reducedMotion.matches) {
            shown = target;
        } else {
            const k = 1 - Math.exp(-Math.min(48, now - previous) / TIME_CONSTANT_MS);
            shown = {
                x: shown.x + (target.x - shown.x) * k,
                y: shown.y + (target.y - shown.y) * k,
                w: shown.w + (target.w - shown.w) * k,
                h: shown.h + (target.h - shown.h) * k,
            };
        }
        previous = now;
        paint(shown);
        nav.classList.add('stor-nav-sliding');
        const distance =
            Math.abs(target.x - shown.x) + Math.abs(target.y - shown.y) +
            Math.abs(target.w - shown.w) + Math.abs(target.h - shown.h);
        if (distance > 0.5 || now < followUntil) {
            frame = requestAnimationFrame(step);
        } else {
            shown = target;
            paint(target);
        }
    };

    const follow = (): void => {
        if (destroyed) return;
        followUntil = performance.now() + FOLLOW_MS;
        if (!frame) {
            previous = performance.now();
            frame = requestAnimationFrame(step);
        }
    };

    const mutations = new MutationObserver(follow);
    mutations.observe(nav, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['aria-current', 'data-open'],
    });
    const resizes = new ResizeObserver(follow);
    resizes.observe(nav);
    window.addEventListener('resize', follow);
    void document.fonts.ready.then(follow);
    follow();

    return () => {
        destroyed = true;
        cancelAnimationFrame(frame);
        mutations.disconnect();
        resizes.disconnect();
        window.removeEventListener('resize', follow);
        nav.classList.remove('stor-nav-sliding');
        pill.remove();
    };
}
