/**
 * 420ebab5 part two — the DOM mechanics behind "one Save per tab", kept OUT of the React component so
 * they can be tested against a plain document instead of through a render.
 *
 * THE SHAPE OF THE PROBLEM. The employee detail screen is a server component whose every editable card is
 * its own `<form action={serverAction}>`. Those forms are not interchangeable: each posts a DIFFERENT set
 * of fields to a DIFFERENT service, several of them carry a sibling card's value through as a hidden input
 * so that saving one card cannot blank another, and `setEmploymentInfo`-style writers read an ABSENT field
 * as "leave as-is" but a present-and-blank one as "clear to NULL". Merging the cards into one physical
 * `<form>` would therefore be a data-loss bug, not a refactor: duplicate `name`s would collide and every
 * section would suddenly post every other section's fields.
 *
 * SO THE FORMS STAY. Each consolidated card keeps its own `<form>`, its own hidden inputs and its own
 * `action={…}` (which is also the no-JavaScript fallback — Next renders a real POST target, so a browser
 * with the bundle blocked still saves that one card exactly as it did before). What changes is that the
 * card's own Save button is gone and the form carries `data-save-section="<id>"`. This module reads those
 * subtrees: it snapshots them, diffs them, marks what moved, and packs the dirty ones into ONE FormData
 * with each section's fields namespaced, so the server can hand each section's own payload to each
 * section's own service, in order (ADR-0001/0003 effective dating — a save closes a version and inserts a
 * new one; it is never one blanket write).
 *
 * WHAT IS DELIBERATELY NOT HERE. Nothing in this file looks at a form's action, and nothing outside a
 * `[data-save-section]` subtree is ever read, marked, packed or reset. That is the bucket (b) fence from
 * docs/audits/420ebab5-personnel-save-classification.md expressed in code: add-a-dependant, terminate-a-CP38,
 * record-a-salary-revision and the other 19 discrete acts are not merely excluded by a list that could rot
 * — they are unreachable, because the page renders them OUTSIDE the scope entirely.
 */

/** Marks a `<form>` (or any element) whose named controls belong to the tab's consolidated Save. */
export const SECTION_ATTR = 'data-save-section';
export const SECTION_SELECTOR = `[${SECTION_ATTR}]`;

// The wire format lives in lib/personnel-tab-sections.ts so the `'use server'` action can read it without
// importing this module, which is full of DOM types a server bundle has no business carrying.
import { SECTION_FIELD_PREFIX, SECTIONS_FIELD } from '@/lib/personnel-tab-sections';

export { SECTION_FIELD_PREFIX, SECTIONS_FIELD };

export type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** One field's state at snapshot time: the raw submitted value(s), plus what the user actually sees. */
export type FieldSnapshot = { value: string; display: string };
export type SectionSnapshot = Record<string, FieldSnapshot>;
export type TabSnapshot = Record<string, SectionSnapshot>;

export type FieldChange = {
  section: string;
  name: string;
  label: string;
  from: string;
  to: string;
};

/** Joins a multi-valued control's values into one comparable string (never occurs in typed input). */
const MULTI_SEP = '\u001F';

function isControl(el: Element): el is FormControl {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  );
}

function isCheckable(el: FormControl): el is HTMLInputElement {
  return el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');
}

/** Every `[data-save-section]` subtree under `root`, in document order. */
export function sectionElements(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(SECTION_SELECTOR));
}

export function sectionId(section: HTMLElement): string {
  return section.getAttribute(SECTION_ATTR) ?? '';
}

/**
 * The named, enabled controls a section would submit. Mirrors FormData's own rules: a disabled control and
 * an unnamed one post nothing, and a nested section's controls belong to that nested section, not this one
 * (there are none today; the check costs nothing and stops a future nesting from double-posting).
 */
export function sectionControls(section: HTMLElement): FormControl[] {
  const out: FormControl[] = [];
  for (const el of Array.from(section.querySelectorAll('input,select,textarea'))) {
    if (!isControl(el)) continue;
    if (!el.name || el.disabled) continue;
    if (el.closest(SECTION_SELECTOR) !== section) continue;
    out.push(el);
  }
  return out;
}

/** The value this control would submit right now — '' when a checkbox/radio is unticked. */
export function controlValue(el: FormControl): string {
  if (el instanceof HTMLSelectElement && el.multiple) {
    return Array.from(el.selectedOptions)
      .map((o) => o.value)
      .join(MULTI_SEP);
  }
  if (isCheckable(el)) return el.checked ? el.value || 'on' : '';
  return el.value;
}

/**
 * What the user SEES for this control — the change summary must read "Executive → Senior Executive", not
 * "3f1a… → 9b0c…". Selects resolve to their option text; the Combobox island (components/ui/combobox.tsx)
 * submits through a hidden input beside a `button[aria-haspopup="listbox"]` whose label is the visible text.
 */
export function controlDisplay(el: FormControl, blankLabel = '—'): string {
  if (el instanceof HTMLSelectElement) {
    const text = el.multiple
      ? Array.from(el.selectedOptions)
          .map((o) => o.text.trim())
          .join(', ')
      : (el.selectedOptions[0]?.text ?? '').trim();
    return text || blankLabel;
  }
  if (isCheckable(el)) return el.checked ? (el.value || 'on') : blankLabel;
  if (el instanceof HTMLInputElement && el.type === 'hidden') {
    const trigger = el.parentElement?.querySelector('button[aria-haspopup="listbox"]');
    const text = trigger?.textContent?.trim();
    if (text) return text;
  }
  return el.value.trim() || blankLabel;
}

/** camelCase / snake_case field name → a readable last-resort label ("permanentCity" → "Permanent City"). */
export function humanizeFieldName(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The label to show for a field in the change summary.
 *
 * `Field` (components/ui.tsx) wraps every control in `<label><span>{label}</span>{control}</label>`, so the
 * nearest enclosing label's first span IS the on-screen caption — including for the controls rendered by a
 * client island inside a Field. A required Field appends a red `*` to that span; it is stripped so the
 * summary reads "Full Name", not "Full Name*". `data-field-label` is the explicit override for a control
 * that has no Field around it.
 */
export function fieldLabel(el: FormControl): string {
  const explicit = el.getAttribute('data-field-label');
  if (explicit) return explicit;
  const wrapper = el.closest('label');
  const caption = wrapper?.querySelector('span')?.textContent?.trim();
  if (caption) return caption.replace(/\*+$/, '').trim() || humanizeFieldName(el.name);
  const aria = el.getAttribute('aria-label');
  if (aria) return aria;
  return humanizeFieldName(el.name);
}

/** Snapshot one section: field name → what it submits and what it shows. */
export function readSection(section: HTMLElement, blankLabel = '—'): SectionSnapshot {
  const out: SectionSnapshot = {};
  for (const el of sectionControls(section)) {
    // Radio groups and checkbox groups share a name; the LAST ticked one wins, which is what a form posts.
    if (isCheckable(el) && !el.checked && out[el.name]) continue;
    out[el.name] = { value: controlValue(el), display: controlDisplay(el, blankLabel) };
  }
  return out;
}

/** Snapshot every section under `root`. */
export function readTab(root: ParentNode, blankLabel = '—'): TabSnapshot {
  const out: TabSnapshot = {};
  for (const section of sectionElements(root)) out[sectionId(section)] = readSection(section, blankLabel);
  return out;
}

/**
 * Is this hidden input something the ADMIN can see and change, or plumbing?
 *
 * Both kinds sit in these forms. The Combobox island (components/ui/combobox.tsx) is a visible control
 * whose value happens to travel in a hidden input beside its `button[aria-haspopup="listbox"]` —
 * Nationality and the passport's Issuing Country are edited that way, and a change summary that hid them
 * would be lying by omission. The rest are plumbing: record ids, the mirrors described under
 * `isMirrorInput`, and provenance markers like `addressCopyVia` that a client island stamps as a side
 * effect of a visible tick. Those are still SUBMITTED — the services need them — they simply have no
 * business in a list headed "what you changed". `data-field-label` opts a hidden input in explicitly.
 */
export function hiddenInputIsUserFacing(el: HTMLInputElement): boolean {
  if (el.hasAttribute('data-field-label')) return true;
  return Boolean(el.parentElement?.querySelector('button[aria-haspopup="listbox"]'));
}

/**
 * Every field whose submitted value differs from the snapshot, with the labels and the before/after the
 * reporter asked to see. Plumbing hidden inputs are excluded from the SUMMARY (see
 * `hiddenInputIsUserFacing`) but never from the payload.
 */
export function diffTab(root: ParentNode, snapshot: TabSnapshot, blankLabel = '\u2014'): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const section of sectionElements(root)) {
    const id = sectionId(section);
    const before = snapshot[id] ?? {};
    const now = readSection(section, blankLabel);
    // One entry PER FIELD NAME, not per control: a radio group is several controls posting one value, and
    // comparing control-by-control would report the two unticked siblings as changes as well.
    const owners = new Map<string, FormControl>();
    for (const el of sectionControls(section)) if (!owners.has(el.name)) owners.set(el.name, el);
    const names = [...owners.keys(), ...Object.keys(before).filter((n) => !owners.has(n))];
    for (const name of names) {
      const el = owners.get(name);
      if (el instanceof HTMLInputElement && el.type === 'hidden' && !hiddenInputIsUserFacing(el)) continue;
      const wasValue = before[name]?.value ?? '';
      const isValue = now[name]?.value ?? '';
      if (wasValue === isValue) continue;
      changes.push({
        section: id,
        name,
        label: el ? fieldLabel(el) : humanizeFieldName(name),
        from: before[name]?.display ?? blankLabel,
        to: now[name]?.display ?? blankLabel,
      });
    }
  }
  return changes;
}

/**
 * A hidden input that exists only to carry a SIBLING section's value through this section's save.
 *
 * Personal Details posts `primaryEmail`/`phone` it does not own and Contact & Address posts `fullName` it
 * does not own, each so that saving one card cannot null the other's column (`updatePerson` writes both).
 * Their server-rendered value is the LAST SAVED one — which is exactly the bug a consolidated save would
 * otherwise introduce: rename someone in Personal Details, change their phone in Contact & Address, save
 * once, and Contact's stale hidden `fullName` would write the OLD name back over the new one. Today's
 * per-card saves are safe from it only because the page reloads between them.
 *
 * A hidden input is a mirror when some OTHER section holds a visible control with the same name.
 */
export function isMirrorInput(root: ParentNode, el: HTMLInputElement): boolean {
  const owner = el.closest(SECTION_SELECTOR);
  for (const section of sectionElements(root)) {
    if (section === owner) continue;
    for (const other of sectionControls(section)) {
      if (other.name !== el.name) continue;
      if (other instanceof HTMLInputElement && other.type === 'hidden') continue;
      return true;
    }
  }
  return false;
}

/**
 * Point every mirror at the value its owning control holds RIGHT NOW, immediately before the payload is
 * built. See `isMirrorInput` for why this is load-bearing rather than tidy.
 */
export function syncCarriedValues(root: ParentNode): void {
  const visible = new Map<string, FormControl>();
  for (const section of sectionElements(root)) {
    for (const el of sectionControls(section)) {
      if (el instanceof HTMLInputElement && el.type === 'hidden') continue;
      if (!visible.has(el.name)) visible.set(el.name, el);
    }
  }
  for (const section of sectionElements(root)) {
    for (const el of sectionControls(section)) {
      if (!(el instanceof HTMLInputElement) || el.type !== 'hidden') continue;
      if (!isMirrorInput(root, el)) continue;
      const source = visible.get(el.name);
      if (!source) continue;
      el.value = controlValue(source);
    }
  }
}

/** The namespaced key one section's field takes in the consolidated payload. */
export function sectionFieldKey(section: string, field: string): string {
  return `${SECTION_FIELD_PREFIX}.${section}.${field}`;
}

/**
 * Pack the named sections into ONE FormData. Each section contributes EXACTLY the entries it would have
 * posted on its own — same fields, same hidden inputs, same absences — under its own namespace, so the
 * server can rebuild each section's payload byte-for-byte and hand it to that section's own service.
 * A section that is not dirty contributes nothing at all and its service is never called.
 */
export function buildTabPayload(
  root: ParentNode,
  dirtySections: string[],
  extra: Record<string, string> = {},
): FormData {
  syncCarriedValues(root);
  const payload = new FormData();
  for (const [k, v] of Object.entries(extra)) payload.set(k, v);
  const packed: string[] = [];
  for (const section of sectionElements(root)) {
    const id = sectionId(section);
    if (!dirtySections.includes(id)) continue;
    packed.push(id);
    for (const el of sectionControls(section)) {
      if (isCheckable(el) && !el.checked) continue;
      if (el instanceof HTMLSelectElement && el.multiple) {
        for (const opt of Array.from(el.selectedOptions)) payload.append(sectionFieldKey(id, el.name), opt.value);
        continue;
      }
      if (el instanceof HTMLInputElement && el.type === 'file') {
        for (const file of Array.from(el.files ?? [])) payload.append(sectionFieldKey(id, el.name), file);
        continue;
      }
      payload.append(sectionFieldKey(id, el.name), el.value);
    }
  }
  payload.set(SECTIONS_FIELD, packed.join(','));
  return payload;
}

/**
 * Mark the fields that moved, so the change is visible on the field itself and not only in the summary.
 * The styling lives in app/globals.css against these attributes rather than in a class string, because
 * the marking is applied to server-rendered nodes this bundle never re-renders.
 */
export function markEditedFields(root: ParentNode, changes: FieldChange[], editedLabel: string): void {
  const dirty = new Set(changes.map((c) => `${c.section}\u0000${c.name}`));
  for (const section of sectionElements(root)) {
    const id = sectionId(section);
    for (const el of sectionControls(section)) {
      const on = dirty.has(`${id}\u0000${el.name}`);
      const wrapper = el.closest('label');
      if (on) {
        el.setAttribute('data-edited', 'true');
        if (wrapper) {
          wrapper.setAttribute('data-edited-field', 'true');
          wrapper.setAttribute('data-edited-label', editedLabel);
        }
      } else {
        el.removeAttribute('data-edited');
        // Another control in the same Field may still be dirty (a date pair, a value+unit pair).
        if (wrapper && !wrapper.querySelector('[data-edited="true"]')) {
          wrapper.removeAttribute('data-edited-field');
          wrapper.removeAttribute('data-edited-label');
        }
      }
    }
  }
}
