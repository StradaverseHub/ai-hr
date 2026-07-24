/**
 * Leave Type configuration workspace (feedback c979aa8b): the Entitlements tab's stacked collapsible
 * leave-type rows became a two-pane workspace —
 *   - an INTERNAL LEFT PANEL listing every leave type (colour dot / icon + name, selected one highlighted
 *     via aria-current + the sidebar's accent pattern) with the Add Leave button at the bottom, collapsing
 *     to a dropdown on mobile;
 *   - a RIGHT workspace showing the SELECTED type's configuration as a horizontal STEP FLOW (1 General
 *     Setting … 4 Custom Settings after b8fcae73 dropped the Eligibility step — see
 *     leave-type-config-active-section.test.ts for the active-step treatment), one section visible at a
 *     time, switched client-side (no reload, no nested tabs).
 *
 * Deep-links keep working: the Leave Types tab's Edit links (#type-<id>, feedback 097de541) and the
 * stay-on-save redirect's anchor (app/admin/actions.ts) select the targeted type in the workspace.
 *
 * 8cc268c4 (Add Leave Type pop-up): the Add Leave button no longer swaps the right pane to the create form
 * (the old ADD-sentinel selection) — it opens a Radix Dialog titled "Add Leave Type" over the current view,
 * whose body is the same server-rendered create form. Save's redirect carries #type-<new id> so the
 * workspace selects the new type and closes the dialog; Cancel closes without saving.
 *
 * Static source guard (repo convention for this DOM-runner-less feature area; see
 * leave-type-config-categories.test.ts). Browser verification covers the interactive behaviour.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const workspaceSrc = readFileSync(resolve(here, '../components/leave-type-workspace.tsx'), 'utf8');
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('c979aa8b · entitlements page renders the two-pane workspace', () => {
  it('the page mounts LeaveTypeWorkspace and feeds it the type list, the per-type panels and the add form', () => {
    // 8cc268c4: the page also imports AddLeaveTypeCancel for the dialog form's footer.
    expect(pageSrc).toMatch(/import \{ AddLeaveTypeCancel, LeaveTypeWorkspace \} from '@\/components\/leave-type-workspace'/);
    expect(pageSrc).toContain('<LeaveTypeWorkspace');
    // Left-panel list entries carry the visual config (colour dot / icon) alongside identity.
    for (const field of ['color: lt.color ?? null', 'icon: lt.icon ?? null', 'archived: !!lt.archivedAt']) {
      expect(pageSrc).toContain(field);
    }
    // The panels slot map: every type's LeaveTypePanel, server actions bound as before.
    expect(pageSrc).toContain('panels={Object.fromEntries(');
    expect(pageSrc).toContain('<LeaveTypePanel');
    // The Add Leave form is the EXISTING create form (a9c5870a's markup — its own layout tests still slice
    // it from this page), passed through untouched as the workspace's addForm slot.
    const addFormIdx = pageSrc.indexOf('addForm={');
    expect(addFormIdx).toBeGreaterThan(-1);
    expect(pageSrc.indexOf('action={createLeaveTypeAction}', addFormIdx)).toBeGreaterThan(addFormIdx);
  });
});

describe('c979aa8b · internal left panel: list + highlight + Add Leave + mobile dropdown', () => {
  it('marks the selected type with aria-current and the accent highlight (sidebar pattern)', () => {
    expect(workspaceSrc).toMatch(/aria-current=\{active \? 'true' : undefined\}/);
    expect(workspaceSrc).toContain('bg-accent');
  });

  it('defaults to the first type and offers Add Leave from the bottom of the panel', () => {
    expect(workspaceSrc).toContain("useState<string>(items[0]?.id ?? '')");
    // 8cc268c4: the Add button opens the Add Leave Type dialog instead of swapping the right pane.
    expect(workspaceSrc).toMatch(/onClick=\{\(\) => setAddOpen\(true\)\}/);
  });

  it('collapses to a dropdown on mobile (the chosen small-screen treatment)', () => {
    // The <select> lives in the md:hidden block; the list nav is hidden until md.
    expect(workspaceSrc).toMatch(/md:hidden[\s\S]*?<select/);
    expect(workspaceSrc).toMatch(/hidden w-56[^"]*md:flex/);
  });
});

describe('8cc268c4 · Add Leave opens the "Add Leave Type" pop-up (no right-pane swap)', () => {
  it('replaces the ADD sentinel swap with a Radix Dialog wrapping the addForm slot', () => {
    expect(workspaceSrc).toContain("import * as Dialog from '@radix-ui/react-dialog'");
    // Controlled open state so BOTH triggers (desktop panel bottom + mobile beside the dropdown) share one
    // dialog, and the post-save hash effect can dismiss it.
    expect(workspaceSrc).toContain('const [addOpen, setAddOpen] = useState(false)');
    expect(workspaceSrc).toMatch(/<Dialog\.Root open=\{addOpen\} onOpenChange=\{setAddOpen\}>/);
    // Title + the untouched server-rendered form as the dialog body.
    expect(workspaceSrc).toMatch(/<Dialog\.Title[^>]*>\{t\('addTypeDialogTitle'\)\}<\/Dialog\.Title>/);
    expect(workspaceSrc).toMatch(/<div className="mt-4">\{addForm\}<\/div>/);
    // The sentinel path is GONE: no ADD constant, no conditional right-pane swap — the right workspace
    // always renders the selected type's panel.
    expect(workspaceSrc.includes("const ADD")).toBe(false);
    expect(workspaceSrc.includes('selected === ADD')).toBe(false);
    // …and the mobile dropdown lists ONLY types (its old Add option became the adjacent trigger button).
    expect(workspaceSrc).not.toMatch(/<option value=\{ADD\}/);
  });

  it('desktop and mobile both trigger the one dialog', () => {
    const triggers = workspaceSrc.match(/onClick=\{\(\) => setAddOpen\(true\)\}/g) ?? [];
    expect(triggers.length).toBe(2);
  });

  it('offers Cancel: the ✕ close plus the exported AddLeaveTypeCancel the form footer mounts', () => {
    // The workspace exports the Dialog.Close wrapper so the SERVER-rendered form can carry the standard
    // bottom-right Cancel/Save footer (Radix context resolves because the slot mounts inside the dialog).
    expect(workspaceSrc).toMatch(/export function AddLeaveTypeCancel/);
    expect(workspaceSrc).toMatch(/AddLeaveTypeCancel[\s\S]*?<Dialog\.Close asChild>/);
    // The page's create form ends with Cancel then Save, bottom-right.
    const formStart = pageSrc.indexOf('action={createLeaveTypeAction}');
    const formEnd = pageSrc.indexOf('</form>', formStart);
    const form = pageSrc.slice(formStart, formEnd);
    const footerIdx = form.indexOf('flex justify-end gap-2');
    expect(footerIdx).toBeGreaterThan(-1);
    const cancelIdx = form.indexOf('<AddLeaveTypeCancel>', footerIdx);
    const saveIdx = form.indexOf('btnPrimary', footerIdx);
    expect(cancelIdx).toBeGreaterThan(footerIdx);
    expect(saveIdx).toBeGreaterThan(cancelIdx);
  });

  it('save selects the new type: the action redirects to the Entitlements tab with #type-<new id>', () => {
    // createLeaveTypeAction captures the created row and lands back on the workspace carrying the
    // 097de541 deep-link anchor…
    const actionIdx = actionsSrc.indexOf('export async function createLeaveTypeAction');
    expect(actionIdx).toBeGreaterThan(-1);
    const actionSlice = actionsSrc.slice(actionIdx, actionsSrc.indexOf('\n}\n', actionIdx));
    expect(actionSlice).toContain('created = await createLeaveType(');
    expect(actionSlice).toContain('redirect(`${ENTITLEMENTS}#type-${created.id}`)');
    expect(actionSlice).toContain('fail(ENTITLEMENTS, e)');
    // …and the workspace's hash effect both selects the targeted type AND dismisses the add dialog.
    expect(workspaceSrc).toMatch(/setSelected\(m\[1\]\);\s*setAddOpen\(false\);/);
  });
});

describe('1bd9a911 · left-side type list: A–Z order + its own scrollbar', () => {
  it('the page sorts the workspace list active-first then A–Z (server-side, so desktop + mobile agree)', () => {
    // The sort lives on the page, on a display copy of `types`, and feeds the workspace's items prop.
    expect(pageSrc).toContain('const workspaceItems = [...types].sort(');
    expect(pageSrc).toContain('Number(!!a.archivedAt) - Number(!!b.archivedAt)');
    expect(pageSrc).toContain("a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })");
    expect(pageSrc).toContain('items={workspaceItems.map((lt) => ({');
    // `panels` stays keyed by id off the unsorted list — order is irrelevant there, so it is untouched.
    expect(pageSrc).toContain('panels={Object.fromEntries(');
    // The client keeps its plain first-item default: items[0] is now the alphabetically first ACTIVE type.
    expect(workspaceSrc).toContain("useState<string>(items[0]?.id ?? '')");
  });

  it('caps the desktop list to a fixed height with its own vertical scrollbar', () => {
    const ul = workspaceSrc.match(/<ul[^>]*className="[^"]*"/)?.[0] ?? '';
    expect(ul).toContain('overflow-y-auto');
    expect(ul).toMatch(/max-h-\[/);
    // The Add Leave button stays OUTSIDE the scrolling <ul>, at the bottom of the nav.
    const ulEnd = workspaceSrc.indexOf('</ul>');
    expect(ulEnd).toBeGreaterThan(-1);
    expect(workspaceSrc.indexOf('className="mt-auto w-full"', ulEnd)).toBeGreaterThan(ulEnd);
  });

  it('keeps the selected type visible inside the scroll panel', () => {
    expect(workspaceSrc).toMatch(/import \{[^}]*useRef[^}]*\} from 'react'/);
    expect(workspaceSrc).toContain('<ul ref={listRef}');
    expect(workspaceSrc).toContain('listRef.current?.querySelector(\'[aria-current="true"]\')');
    expect(workspaceSrc).toContain("scrollIntoView({ block: 'nearest' })");
    // …re-run whenever the selection changes (hash deep-link, just-added type, click).
    expect(workspaceSrc).toMatch(/scrollIntoView[\s\S]{0,80}\}, \[selected\]\);/);
  });
});

describe('c979aa8b · hash deep-link still selects the type', () => {
  it('selects #type-<id> on mount and on hashchange, and writes the hash back on selection', () => {
    // The effect replaces the old per-row expand effect that lived in leave-type-panel.tsx.
    expect(workspaceSrc).toMatch(/window\.location\.hash\.match\(\/\^#type-\(\.\+\)\$\/\)/);
    expect(workspaceSrc).toContain("window.addEventListener('hashchange', applyHash)");
    // replaceState keeps the current type in the URL so the stay-on-save redirect + reloads land back on it.
    expect(workspaceSrc).toContain('window.history.replaceState');
    // …and the panel no longer owns hash handling (single owner: the workspace).
    expect(panelSrc.includes('hashchange')).toBe(false);
  });
});

describe('c979aa8b · step bar: numbered 1–4, category labels, one section at a time', () => {
  it('renders the four steps in walk order with a numeric 1-based badge', () => {
    // b8fcae73: the Eligibility step is gone and the walk reordered — 1 General · 2 Condition ('ess' is
    // Condition's historical storage key) · 3 Entitlement · 4 Custom. The bar is ONE map over STEP_KEYS, so
    // this array IS the numbering and the Previous/Next walk order.
    expect(panelSrc).toContain("const STEP_KEYS = ['general', 'ess', 'entitlement', 'custom'] as const");
    // The visible number is the 1-based index of the map — step 1 General … step 4 Custom.
    expect(panelSrc).toContain('{i + 1}');
    // Labels reuse the existing category* title keys (all six locales already carry them).
    for (const titleKey of [
      "general: 'categoryGeneral'",
      "entitlement: 'categoryEntitlement'",
      "ess: 'categoryEssPolicy'",
      "custom: 'categoryCustom'",
    ]) {
      expect(panelSrc).toContain(titleKey);
    }
    // The retired step's title mapping is gone with it.
    expect(panelSrc.includes("eligibility: 'categoryEligibilityEntitlement'")).toBe(false);
  });
});

describe('c979aa8b · workspace strings exist in every locale', () => {
  it('has the type-list and step-bar labels in all six locales', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      for (const key of ['workspaceTypeListLabel', 'workspaceStepsLabel', 'addTypeDialogTitle']) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
