/**
 * Leave Type configuration workspace (feedback c979aa8b): the Entitlements tab's stacked collapsible
 * leave-type rows became a two-pane workspace —
 *   - an INTERNAL LEFT PANEL listing every leave type (colour dot / icon + name, selected one highlighted
 *     via aria-current + the sidebar's accent pattern) with the Add Leave button at the bottom, collapsing
 *     to a dropdown on mobile;
 *   - a RIGHT workspace showing the SELECTED type's configuration as a horizontal STEP FLOW (1 General
 *     Setting … 5 Custom Settings — see leave-type-config-active-section.test.ts for the active-step
 *     treatment), one section visible at a time, switched client-side (no reload, no nested tabs).
 *
 * Deep-links keep working: the Leave Types tab's Edit links (#type-<id>, feedback 097de541) and the
 * stay-on-save redirect's anchor (app/admin/actions.ts) select the targeted type in the workspace.
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

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('c979aa8b · entitlements page renders the two-pane workspace', () => {
  it('the page mounts LeaveTypeWorkspace and feeds it the type list, the per-type panels and the add form', () => {
    expect(pageSrc).toMatch(/import \{ LeaveTypeWorkspace \} from '@\/components\/leave-type-workspace'/);
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
    expect(workspaceSrc).toContain("useState<string>(items[0]?.id ?? ADD)");
    // The Add button swaps the right pane to the create form (the ADD sentinel selection).
    expect(workspaceSrc).toMatch(/onClick=\{\(\) => select\(ADD\)\}/);
    expect(workspaceSrc).toContain("selected === ADD ? (");
  });

  it('collapses to a dropdown on mobile (the chosen small-screen treatment)', () => {
    // The <select> lives in the md:hidden block; the list nav is hidden until md.
    expect(workspaceSrc).toMatch(/md:hidden[\s\S]*?<select/);
    expect(workspaceSrc).toMatch(/hidden w-56[^"]*md:flex/);
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

describe('c979aa8b · step bar: numbered 1–5, category labels, one section at a time', () => {
  it('renders the five steps in walk order with a numeric 1-based badge', () => {
    expect(panelSrc).toContain("const STEP_KEYS = ['general', 'eligibility', 'entitlement', 'ess', 'custom'] as const");
    // The visible number is the 1-based index of the map — step 1 General … step 5 Custom.
    expect(panelSrc).toContain('{i + 1}');
    // Labels reuse the existing category* title keys (all six locales already carry them).
    for (const titleKey of [
      "general: 'categoryGeneral'",
      "eligibility: 'categoryEligibilityEntitlement'",
      "entitlement: 'categoryEntitlement'",
      "ess: 'categoryEssPolicy'",
      "custom: 'categoryCustom'",
    ]) {
      expect(panelSrc).toContain(titleKey);
    }
  });
});

describe('c979aa8b · workspace strings exist in every locale', () => {
  it('has the type-list and step-bar labels in all six locales', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      for (const key of ['workspaceTypeListLabel', 'workspaceStepsLabel']) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
