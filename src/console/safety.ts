// The Copilot's hard safety rules. They run in the content script, so they hold no matter what the
// model (or a compromised backend) asks for: risky controls become a "your turn" prompt, secrets are
// never typed or read, and only console pages are touched.
import type { SnapshotItem } from './types';

import { byIdFrom } from './dom';
import { isCommit, isConsoleUrl, isRisky, playerOnlyPage } from './risk';

export { isConsoleUrl, isRisky };

const SENSITIVE_NAME = /(password|secret|token|access ?key|private ?key|credential|mfa|otp|card|cvv|iban)/i;

/** Inputs whose value must never be read or typed by the agent. */
export function isSensitiveInput(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (type === 'password') return true;
  const hint = [el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('aria-label'), el.placeholder].join(' ');
  return SENSITIVE_NAME.test(hint);
}

export type Verdict = { ok: true } | { ok: false; reason: 'risky' | 'sensitive' | 'missing' | 'disabled' | 'player-only' | 'commit'; message: string };

/**
 * Every label a control carries — a page could name a Delete button "Next" in one place but not all.
 * Each signal is capped on its own (not the joined string), so a long Cloudscape class list can't push
 * the visible text out of the check.
 */
export function riskSignals(el: Element): string {
  const h = el as HTMLElement;
  const refs = (attr: string) => (el.getAttribute(attr) ?? '').split(/\s+/).map((id) => (id ? byIdFrom(el, id)?.textContent : ''));
  return [
    el.getAttribute('aria-label'),
    ...refs('aria-labelledby'),
    el.getAttribute('title'),
    el.getAttribute('data-testid'),
    el.getAttribute('name'),
    el.getAttribute('value'),
    // A native select's text is every option's; mayAct checks the one it picks (optionFor), so a risky option
    // elsewhere in the list doesn't refuse a safe pick.
    el instanceof HTMLSelectElement ? undefined : (h.innerText ?? el.textContent),
    el.closest('label')?.textContent,
    // what a screen reader reads with it (Cloudscape puts option and tile descriptions here)
    ...refs('aria-describedby'),
    el.closest('form')?.getAttribute('action'),
    el.closest('[role=dialog]')?.querySelector('h1,h2,h3')?.textContent,
    el.getAttribute('class'),
  ]
    .filter(Boolean)
    // Generous per-signal cap: a long tile or card description must not push "delete" out of the check.
    .map((s) => s!.replace(/\s+/g, ' ').trim().slice(0, 4000))
    .join(' ');
}

/** The control a click really lands on: a click on an icon or span inside a "Delete" button is a Delete click. */
const CONTROL = 'button, a[href], [role=button], [role=menuitem], [role=menuitemradio], [role=option], [role=tab], [role=link], label, summary';
export function controlsAround(el: Element): Element[] {
  const out: Element[] = [];
  for (let p: Element | null = el.parentElement, depth = 0; p && depth < 6; p = p.parentElement, depth++) {
    if (p.matches(CONTROL)) out.push(p);
  }
  return out;
}

/** Links that leave the AWS console are never followed by the agent. */
export function leavesConsole(el: Element): boolean {
  const a = el.closest('a[href]') as HTMLAnchorElement | null;
  if (!a) return false;
  try {
    return !isConsoleUrl(new URL(a.getAttribute('href') ?? '', el.ownerDocument.location?.href).href);
  } catch {
    return true;
  }
}

/** The option a `select` step picks. `choose` uses this same lookup, so the check covers exactly what gets chosen. */
export function optionFor(el: Element, value: string): HTMLOptionElement | undefined {
  if (!(el instanceof HTMLSelectElement)) return undefined;
  return [...el.options].find((o) => o.value === value || o.textContent?.trim().toLowerCase() === value.toLowerCase());
}

const DANGER_CLASS = /\b(danger|destructive|delete)\b/i;
/** Cloudscape's primary button (`awsui_variant-primary_<hash>`), or the older AWS UI's (`awsui-button-variant-primary`). */
const PRIMARY_CLASS = /\bawsui[_-](button-)?variant-primary/i;

/**
 * The page marks this control (or the button it sits in) as the form's main action: the primary variant, or a native
 * form's submit button. Cloudscape renders nearly every button `type="submit"` (its formAction defaults to submit), so
 * for its buttons only the variant counts.
 */
export function isMainAction(el: Element): boolean {
  if ([el, ...controlsAround(el)].some((c) => PRIMARY_CLASS.test(c.getAttribute('class') ?? ''))) return true;
  const submit = (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && el.type === 'submit' && !!el.form;
  return submit && !/\bawsui/.test(el.getAttribute('class') ?? '');
}

/**
 * Phase two of a custom (Cloudscape) select: the option the agent is about to click, checked on all its
 * own signals (text, description, aria-label, test id, class) plus the field it belongs to.
 */
export function mayChoose(option: Element, fieldName = ''): Verdict {
  const label = (option.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (option.getAttribute('aria-disabled') === 'true' || option.hasAttribute('disabled'))
    return { ok: false, reason: 'disabled', message: `“${label}” can’t be picked right now.` };
  if (isRisky(riskSignals(option)) || isRisky(label, fieldName) || DANGER_CLASS.test(option.getAttribute('class') ?? '') || leavesConsole(option))
    return { ok: false, reason: 'risky', message: `Choosing “${label}” can change something important — your turn to pick it.` };
  return { ok: true };
}

/** A native <select> or a dropdown that opens a list (act.ts isCustomSelect): picking there never presses a button. */
const opensAList = (el: Element) => el instanceof HTMLSelectElement || el.getAttribute('aria-haspopup') === 'listbox' || el.getAttribute('role') === 'combobox';

/**
 * Decide whether the agent may act on this element itself. `url` is the page's (the element's document by default):
 * on the real console's player-only pages (`PLAYER_ONLY_PAGES`) every click, pick and keystroke is the player's.
 */
export function mayAct(item: SnapshotItem | undefined, action: string, el?: Element, value?: string, url = el?.ownerDocument.location?.href): Verdict {
  if (!item) return { ok: false, reason: 'missing', message: 'I can’t find that on the page.' };
  const only = playerOnlyPage(url);
  if (only && (action === 'click' || action === 'select' || action === 'type'))
    return { ok: false, reason: 'player-only', message: `On ${only.name} pages, changes are yours to make, so this one is your turn. I’ll point and explain.` };
  if (el && (action === 'click' || action === 'select')) {
    const around = controlsAround(el);
    if (isRisky(riskSignals(el)) || DANGER_CLASS.test(el.getAttribute('class') ?? '') || around.some((c) => isRisky(riskSignals(c)) || DANGER_CLASS.test(c.getAttribute('class') ?? '')))
      return { ok: false, reason: 'risky', message: `“${item.name}” looks like it can change or delete something important — your turn to click it.` };
    if (leavesConsole(el)) return { ok: false, reason: 'risky', message: 'That link leaves the AWS console — your turn if you want to follow it.' };
    // Check the option that will actually be chosen, not just the value sent: value="2" can label "Disable…".
    const opt = action === 'select' && value !== undefined ? optionFor(el, value) : undefined;
    if (opt && isRisky(`${opt.textContent ?? ''} ${opt.value} ${opt.getAttribute('label') ?? ''}`))
      return { ok: false, reason: 'risky', message: `Choosing “${opt.textContent?.trim()}” can change something important — your turn to pick it.` };
  }
  if (el && action === 'type' && isSensitiveInput(el)) return { ok: false, reason: 'sensitive', message: 'That field holds a secret — please fill it in yourself.' };
  // Typing is checked like clicking: delete dialogs ask you to type "delete"/the name to confirm, and
  // the agent must never fill those in.
  if (el && action === 'type' && (isRisky(riskSignals(el)) || isRisky(value ?? '') || /\b(confirm|to confirm)\b/i.test(riskSignals(el))))
    return { ok: false, reason: 'risky', message: 'This field confirms something important — please type it yourself.' };
  if (item.disabled) return { ok: false, reason: 'disabled', message: `“${item.name}” is disabled right now.` };
  if (item.sensitive) return { ok: false, reason: 'sensitive', message: 'That field holds a secret — please fill it in yourself.' };
  if ((action === 'click' || action === 'select' || action === 'type') && (isRisky(item.name, item.context) || isRisky(value ?? ''))) {
    return { ok: false, reason: 'risky', message: `“${item.name}” can change or cost something important — your turn to click it.` };
  }
  // On the real console the press that commits a form (creates, launches, saves…) is the player's (isCommit). A
  // "select" on anything that isn't a dropdown ends in the same press (act.ts choose → press), so it counts too.
  if ((action === 'click' || (action === 'select' && !!el && !opensAList(el))) && isCommit(url, item.role, item.name, !!el && isMainAction(el)))
    return { ok: false, reason: 'commit', message: `Your turn: press “${item.name}” when you’re happy with the settings.` };
  return { ok: true };
}
