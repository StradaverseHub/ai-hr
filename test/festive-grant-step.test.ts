/**
 * Move the One-Off / Festive Leave Grant section into the Leave Type Entitlement step (feedback fd7c8e20).
 *
 * The festive / one-off grant tool (ADR-0066, components/festive-grant-card.tsx) no longer renders as a
 * standalone section at the bottom of the Entitlements page. It now lives INSIDE each leave type's
 * Entitlement step (step 3 of the c979aa8b workspace), below the Benefit Schemes area (6c775d68):
 *   - The grant form arrives PRESET to the hosting leave type (defaultLeaveTypeId) — the select stays
 *     changeable, so cross-type grants remain possible without leaving the workspace.
 *   - Recent grants default-filter to the hosting type, with a toggle to view every type's grants. The
 *     filter is DISPLAY-only: one shared recentGrants array, so grants for other types stay intact and
 *     reachable from any panel.
 *   - The grant data (admin-scoped companies, recent grants, today's date) is prepared ONCE at page level
 *     and shared by every panel — only the preselected type varies (no N+1 per type).
 *   - Grant WRITING is untouched: the same grantAdHocLeaveAction, the same MultiSelectPopover companyIds
 *     contract (multiselect-form-contract.test.ts), the same audit rows.
 *
 * Static source guard (repo convention for this DOM-runner-less feature area — see
 * benefit-scheme-scoped-step.test.ts / leave-type-config-categories.test.ts). What a static test CANNOT
 * prove — granting from within a type's step 3 landing in balances, and the toggle actually swapping the
 * visible list — is assigned to browser verification. Grant BEHAVIOUR (credit, audit, multi-company) is
 * covered end-to-end by test/per-company-entitlement.test.ts, which this move does not touch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const cardSrc = readFileSync(resolve(here, '../components/festive-grant-card.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('fd7c8e20 · the standalone festive-grant section is gone from the page bottom', () => {
  it('no longer renders a festiveTitle SectionHeader card', () => {
    expect(pageSrc).not.toMatch(/SectionHeader title=\{t\('festiveTitle'\)\}/);
  });

  it('composes FestiveGrantCard ONCE per type inside the panels map, preset to that type', () => {
    // Exactly one <FestiveGrantCard …> composition remains — the per-panel one in the slot.
    expect(pageSrc.match(/<FestiveGrantCard/g)?.length).toBe(1);
    expect(pageSrc).toContain('defaultLeaveTypeId={lt.id}');
    // …passed into the panel through the Entitlement-step slot, headed by the kept i18n title.
    expect(pageSrc).toContain('festiveGrantSection={');
    expect(pageSrc).toContain("{t('festiveTitle')}");
  });

  it('prepares the grant data ONCE at page level (no N+1 per type)', () => {
    // The loader still runs once in the page-level Promise.all; the mapped rows and admin-scoped company
    // list are built once and shared by every panel.
    expect(pageSrc.match(/listAdHocLeaveGrants\(s\)/g)?.length).toBe(1);
    expect(pageSrc.match(/const recentGrants: FestiveGrantRow\[\] = /g)?.length).toBe(1);
    expect(pageSrc.match(/const festiveCompanies = /g)?.length).toBe(1);
    // The row mapping carries the raw type id so the card can display-filter by hosting type.
    expect(pageSrc).toContain('leaveTypeId: g.leaveTypeId ?? null');
  });
});

describe('fd7c8e20 · the panel renders the grant tool inside the Entitlement step, below the schemes area', () => {
  it('the festiveGrantSection slot renders after benefitSchemeSection and before the Condition step', () => {
    const schemes = panelSrc.indexOf('{benefitSchemeSection}');
    const slot = panelSrc.indexOf('{festiveGrantSection}');
    const nextStep = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
    expect(schemes).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(schemes);
    expect(nextStep).toBeGreaterThan(slot);
  });
});

describe('fd7c8e20 · default-type prefill — preset to the hosting type, still changeable', () => {
  it('the leave-type select defaults to defaultLeaveTypeId (empty placeholder when standalone)', () => {
    expect(cardSrc).toContain('defaultLeaveTypeId?: string');
    expect(cardSrc).toContain(`defaultValue={defaultLeaveTypeId ?? ''}`);
  });

  it('the select is NOT locked — cross-type grants stay possible from inside the workspace', () => {
    // The plan prefers preselect-with-change over a locked select; a disabled/readOnly type select
    // would strand cross-type grants now that the standalone section is gone.
    const selectAt = cardSrc.indexOf('name="leaveTypeId"');
    expect(selectAt).toBeGreaterThan(-1);
    const selectTag = cardSrc.slice(cardSrc.lastIndexOf('<select', selectAt), cardSrc.indexOf('>', selectAt) + 1);
    expect(selectTag).not.toMatch(/disabled|readOnly/);
    // …and the full type catalogue is still offered as options.
    expect(cardSrc).toContain('{leaveTypes.map((lt) => (');
  });
});

describe('fd7c8e20 · filtered listing — display-only scope with a view-all toggle', () => {
  it('recent grants default-filter to the hosting type, toggling to the FULL shared array', () => {
    // Display filter only: the widened view renders the same `recent` array — grants for other leave
    // types are never dropped from the data, so they stay intact and reachable.
    expect(cardSrc).toContain('const scopedToType = !!defaultLeaveTypeId && !showAllTypes');
    expect(cardSrc).toContain(
      'const visibleGrants = scopedToType ? recent.filter((r) => r.leaveTypeId === defaultLeaveTypeId) : recent',
    );
    expect(cardSrc).toContain('{visibleGrants.map((r, i) => (');
  });

  it('the toggle only exists when hosted in a type step, and the scoped empty state is distinct', () => {
    expect(cardSrc).toMatch(/\{defaultLeaveTypeId && \([\s\S]{0,400}setShowAllTypes\(\(v\) => !v\)/);
    expect(cardSrc).toMatch(/showAllTypes \? t\('festiveShowTypeOnly'\) : t\('festiveShowAllTypes'\)/);
    expect(cardSrc).toMatch(/scopedToType \? t\('festiveRecentEmptyForType'\) : t\('festiveRecentEmpty'\)/);
  });

  it('grant WRITING is untouched: same action, same posted fields', () => {
    expect(cardSrc).toContain("import { grantAdHocLeaveAction } from '@/app/admin/actions'");
    for (const field of ['name="companyIds"', 'name="days"', 'name="effectiveOn"', 'name="reason"', 'name="expiresOn"']) {
      expect(cardSrc.includes(field), `${field} still posted`).toBe(true);
    }
  });
});

describe('fd7c8e20 · i18n — the new strings exist in every locale', () => {
  it('has festiveShowAllTypes / festiveShowTypeOnly / festiveRecentEmptyForType in all 6 locales', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      for (const key of ['festiveShowAllTypes', 'festiveShowTypeOnly', 'festiveRecentEmptyForType']) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
