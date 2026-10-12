/// Tells the shell whether the pointer is over a background, whichever version of the page is deployed.
/// The shell injects it, because the page cannot do this alone: a web view gives the window no drag area.
/// The window itself starts the drag on the mouse-down (`StorWindow`), which has to happen synchronously
/// and so cannot wait for the page to answer.
///
/// A background is anything that is not a control, not text, not a graphic and not clickable (a link,
/// button, field, role, `draggable`, `cursor: pointer`, or anything marked `data-stor-no-drag`).
/// `data-stor-drag` marks areas that count even over text. While a dialog, drawer or menu is open
/// nothing counts, so a click outside it still closes it.
enum WindowDragScript {
    static let source = #"""
(() => {
    if (window.__storWindowDrag) return;
    window.__storWindowDrag = true;
    const INTERACTIVE = 'a, button, input, select, textarea, summary, label, video, audio, iframe, canvas, embed, object, ' +
        '[role="button"], [role="link"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], ' +
        '[role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="slider"], [role="spinbutton"], [role="textbox"], ' +
        '[role="searchbox"], [role="combobox"], [role="listbox"], [role="scrollbar"], [contenteditable]:not([contenteditable="false"]), ' +
        '[draggable="true"], [tabindex]:not([tabindex="-1"])';
    const OVERLAY = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"], [data-stor-drawer]';
    const ownText = (element) => {
        for (const node of element.childNodes) if (node.nodeType === 3 && node.nodeValue.trim() !== '') return true;
        return false;
    };
    const isBackground = (target) => {
        if (!(target instanceof Element) || target instanceof SVGElement) return false;
        if (target.closest(INTERACTIVE) || target.closest('[data-stor-no-drag]')) return false;
        if (document.querySelector(OVERLAY)) return false;
        if (target.closest('[data-stor-drag]')) return true;
        if (ownText(target)) return false;
        const cursor = getComputedStyle(target).cursor;
        return cursor === 'auto' || cursor === 'default';
    };
    let reported = false;
    let lastTarget = null;
    const report = (on) => {
        if (on === reported) return;
        reported = on;
        try {
            window.webkit.messageHandlers.stor.postMessage({ type: 'backgroundHover', body: { on } });
        } catch {}
    };
    const options = { capture: true, passive: true };
    document.addEventListener('mousemove', (event) => {
        if (event.target === lastTarget && reported === (lastTarget !== null)) return;
        lastTarget = event.target;
        report(isBackground(event.target));
    }, options);
    // Pressing re-checks, so a menu or dialog that opened under a still pointer is noticed for the next click.
    document.addEventListener('mousedown', (event) => { lastTarget = event.target; report(isBackground(event.target)); }, options);
    document.addEventListener('mouseout', (event) => { if (!event.relatedTarget) { lastTarget = null; report(false); } }, options);
    window.addEventListener('blur', () => { lastTarget = null; report(false); });
})();
"""#
}
