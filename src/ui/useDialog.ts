import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog's keyboard contract, in one place: focus moves in when it opens (to `initial`, else the first
 * control), Tab and Shift+Tab stay inside, Escape closes it from anywhere on the page, and focus goes back to what
 * had it before.
 */
export function useDialog(open: boolean, box: RefObject<HTMLElement | null>, onClose: () => void, initial?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const focusables = () => [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => !el.closest('[inert]'));
    (initial?.current ?? focusables()[0] ?? box.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // A popover inside (a glossary term) handles its own Escape first and stops it.
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== 'Tab' || !box.current) return;
      const els = focusables();
      if (!els.length) return e.preventDefault();
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !box.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !box.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Back to where the player was, if it's still on the page.
      if (before?.isConnected) before.focus();
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Focus is never lost to <body> from `box` (the side panel): when the control that had it goes (a To-do row ticked, a
 * tab or a building's card swapped in), focus lands on the new panel's heading (the building's name, "To do"), else the
 * panel from `landing`. Only when focus was in `box`: after a press on the city (or anywhere else) the keys stay there.
 */
export function useKeepFocus(box: RefObject<HTMLElement | null>, landing: () => HTMLElement | null | undefined) {
  const land = useRef(landing);
  land.current = landing;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let last: Element | undefined;
    const onIn = (e: FocusEvent) => {
      last = el.contains(e.target as Node) ? (e.target as Element) : undefined;
    };
    const onDown = (e: Event) => {
      if (!el.contains(e.target as Node)) last = undefined;
    };
    const watch = new MutationObserver(() => {
      if (!last || last.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== last) return;
      last = undefined;
      const to = land.current();
      if (!to) return;
      const heading = to.querySelector<HTMLElement>('h2, h3');
      if (heading && !heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading?.focus();
      if (!heading || document.activeElement !== heading) to.focus();
    });
    watch.observe(el, { childList: true, subtree: true });
    document.addEventListener('focusin', onIn);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      watch.disconnect();
      document.removeEventListener('focusin', onIn);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [box]);
}

/** The presses Phaser also hears on the window (its "outside the canvas" listeners), so it would act under a card. */
const GAME_PRESSES = ['mousedown', 'mouseup', 'touchstart', 'touchend', 'touchcancel'] as const;

/**
 * A card over the city is modal for the game too: Phaser listens for mouse and touch presses on the whole window, so a
 * tap on a card's backdrop (or on the card) would still select a building, pan the camera or walk Kai. Those presses
 * stop at `el`; clicks (what React's buttons use) and pointer events (the glossary popovers) still go through. `again`
 * changing shields the element anew (the quick tour's card moving into the side panel's dock is a new element).
 */
export function useShieldGame(open: boolean, el: RefObject<HTMLElement | null>, again?: unknown) {
  useEffect(() => {
    const node = el.current;
    if (!open || !node) return;
    const stop = (e: Event) => e.stopPropagation();
    for (const type of GAME_PRESSES) node.addEventListener(type, stop);
    return () => {
      for (const type of GAME_PRESSES) node.removeEventListener(type, stop);
    };
  }, [open, el, again]);
}
