// Who may take the focus when something appears by itself (a composer, a decision card, a secure
// form, a question). The rule: nothing in the chat steals the focus from a modal surface that is
// open (the palette, a dialog), and nothing steals it from someone typing. A modal surface is
// anything marked `aria-modal="true"`; the thing taking the focus must be inside it.

const MODAL = '[aria-modal="true"]';

/** The topmost modal surface: the last one in the document (a dialog opened from another is in the body, after it). */
const topModal = (doc: Document): Element | null => {
  const all = doc.querySelectorAll(MODAL);
  return all.item(all.length - 1);
};

/** A modal surface (palette, dialog) is open. */
export const modalOpen = (doc: Document = document): boolean => doc.querySelector(MODAL) !== null;

/** `el` may take the focus now: no modal is open, or `el` is inside the open modal. */
export function mayTakeFocus(el: Element, doc: Document = document): boolean {
  const modal = topModal(doc);
  return modal === null || modal.contains(el);
}

/** Focus `el` for a thing that just appeared, unless a modal surface is open. Says whether it did. */
export function focusOnAppearance(el: HTMLElement | null | undefined): boolean {
  if (el === null || el === undefined || !mayTakeFocus(el)) return false;
  el.focus();
  return true;
}
