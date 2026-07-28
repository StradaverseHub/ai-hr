/**
 * Restructure Leave Type Configuration Tabs and Reorganize Settings Location (feedback 123c1e76).
 *
 * The leave-type config panel (components/leave-type-panel.tsx) previously rendered SEVEN category cards
 * (d842ea46). This item restructures them into FIVE — General Setting, Eligibility (renamed from
 * "Eligibility & Entitlement Policy"), Entitlement (NEW: the per-type benefit-scheme entitlement table),
 * Condition (renamed from "Employee Self Service Policy") and Custom Settings — and relocates three
 * sections:
 *   - Per Date Approval  : Approval Rules card (retired)          → General Setting card
 *   - Day Type Inclusion : Leave Calculation Rules card (retired) → Condition card
 *   - Leave Information Display card content (retired)            → Custom Settings card
 *
 * PURE PRESENTATION: every sub-form's markup / tri-state marker / server action is byte-identical — only
 * the card nesting, titles and order changed. The new Entitlement card is a filtered read-and-edit view of
 * the SAME scheme_leave_entitlement rows the shared Benefit Schemes area manages (same upsert action — no
 * duplicated configuration). This guards, statically (the suite has no DOM runner for this component — the
 * repo convention for this UI-only file; see leave-type-edit-layout.test.ts):
 *   1. The 4 category cards render, in order, each titled by its admin.leave.category* key.
 *   2. Every sub-form's tri-state marker survived AND landed in its assigned category (no form dropped,
 *      none misfiled) — so nothing stopped posting its marker.
 *   3. The retired cards are gone from the panel and their title keys retired from every locale.
 *   4. The renamed + new category titles exist in all six locales (en pins the exact reported wording).
 *   5. The per-type Entitlement table reuses the benefit-scheme row components + upsert action, and its
 *      strings exist in all six locales.
 *
 * Step flow (c979aa8b): the cards are no longer independent accordions — they are the STEPS of the
 * leave-type workspace (one section visible at a time, chosen by the numbered step bar; see
 * leave-type-workspace.test.ts). The invariants above are UNCHANGED: same titles in the same source
 * order, same content assignment, same storage keys (now persisting the active step instead of open flags).
 *
 * Workflow shortened (b8fcae73): the Eligibility step is REMOVED and the walk reordered to
 * 1 General · 2 Condition · 3 Entitlement · 4 Custom. That card had held no eligibility rules since
 * 08bc6841 moved them to Condition · Criteria; its surviving content (the per-company entitlement policies
 * timeline) relocated INTO the Entitlement step as its Company Entitlements sub-step, so the two needles
 * below moved from the categoryEligibilityEntitlement list into categoryEntitlement's, and
 * categoryEligibilityEntitlement joins RETIRED_KEYS (unreferenced by the panel, undefined in every locale).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const schemeSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** Physical CardTitle order in the panel source (b8fcae73 dropped the Eligibility card). */
const CATEGORY_KEYS = [
  'categoryGeneral',
  'categoryEntitlement',
  'categoryEssPolicy',
  'categoryCustom',
] as const;

/** The cards these restructures retire — their content moved, the card (and title key) is gone. */
const RETIRED_KEYS = [
  'categoryApproval',
  'categoryDisplay',
  'categoryCalculation',
  // b8fcae73: the Eligibility step, emptied of eligibility rules by 08bc6841 and now merged into
  // Entitlement · Company Entitlements.
  'categoryEligibilityEntitlement',
] as const;

/** The category → the markers/anchors that must live inside that category's card, in the new grouping. */
const CATEGORY_CONTENT: Record<(typeof CATEGORY_KEYS)[number], string[]> = {
  categoryGeneral: [
    'name="identity"',
    'name="leaveUnit"',
    // moved here from the retired Approval Rules card
    'name="partialApproval"',
  ],
  categoryEntitlement: [
    // the NEW per-type benefit-scheme entitlement table (filtered view, shared rows + action)
    '<LeaveTypeEntitlementTable',
    // 6c775d68: the scoped Benefit Schemes management area follows the table inside the same step
    '{benefitSchemeSection}',
    // fd7c8e20: the One-Off / Festive Leave Grant tool completes the step, below the schemes area
    '{festiveGrantSection}',
    // b8fcae73: the per-company entitlement policies timeline, relocated here from the retired
    // Eligibility card as this step's Company Entitlements sub-step (08bc6841 had already moved the
    // eligibility rules / expiry sub-forms to Condition · Criteria / Expiry).
    "t('companyEntitlements')",
    "t('addEntitlement')",
  ],
  categoryEssPolicy: [
    // 08bc6841: moved here from the Eligibility card (Criteria sub-step)
    'name="eligibility"',
    'name="durations"',
    'name="document"',
    'name="negativeBalance"',
    'name="backdating"',
    'name="minAdvance"',
    'name="duplicatePolicy"',
    // moved here from the retired Leave Calculation Rules card
    'name="dayTypeInclusion"',
    // 08bc6841: moved here from the Eligibility card (Expiry sub-step)
    'name="expiry"',
  ],
  categoryCustom: [
    // moved here from the retired Leave Information Display card
    'name="essView"',
    'name="formula"',
    'name="visibility"',
    'name="placement"',
    'name="applyNotice"',
    '<LeaveVisualForm',
  ],
};

/** Split the file into the 5 card segments, keyed by category, using the <CardTitle>{t('categoryX')}</CardTitle>
 *  markers as boundaries (each segment runs from its title to the next title, last to EOF). */
function cardSegments(): Record<string, string> {
  const idxs = CATEGORY_KEYS.map((k) => {
    const anchor = `<CardTitle>{t('${k}')}</CardTitle>`;
    const at = panelSrc.indexOf(anchor);
    expect(at, `CardTitle for ${k} present`).toBeGreaterThan(-1);
    return { k, at };
  });
  // Titles appear in declared order.
  for (let i = 1; i < idxs.length; i++) {
    expect(idxs[i].at, `${idxs[i].k} after ${idxs[i - 1].k}`).toBeGreaterThan(idxs[i - 1].at);
  }
  const out: Record<string, string> = {};
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i].at;
    const end = i + 1 < idxs.length ? idxs[i + 1].at : panelSrc.length;
    out[idxs[i].k] = panelSrc.slice(start, end);
  }
  return out;
}

describe('123c1e76 · leave-type config restructured into 4 category cards (b8fcae73 dropped Eligibility)', () => {
  it('renders exactly the 4 category CardTitles, in order', () => {
    const seq = CATEGORY_KEYS.map((k) => `<CardTitle>{t('${k}')}</CardTitle>`);
    let cursor = -1;
    for (const s of seq) {
      const at = panelSrc.indexOf(s, cursor + 1);
      expect(at, `${s} present after previous`).toBeGreaterThan(cursor);
      cursor = at;
    }
    // No stray extra category card.
    const titleCount = (panelSrc.match(/<CardTitle>/g) ?? []).length;
    expect(titleCount).toBe(CATEGORY_KEYS.length);
  });

  it('places every sub-form marker/anchor inside its assigned category card', () => {
    const segs = cardSegments();
    for (const key of CATEGORY_KEYS) {
      for (const needle of CATEGORY_CONTENT[key]) {
        expect(segs[key].includes(needle), `${needle} should live in ${key} card`).toBe(true);
      }
    }
  });

  it('keeps every tri-state marker globally (no sub-form dropped by the moves)', () => {
    for (const markers of Object.values(CATEGORY_CONTENT)) {
      for (const needle of markers) {
        expect(panelSrc.includes(needle), `${needle} still present`).toBe(true);
      }
    }
  });

  it('retires the Approval Rules / Leave Information Display / Leave Calculation Rules cards', () => {
    for (const key of RETIRED_KEYS) {
      expect(panelSrc.includes(`t('${key}')`), `${key} no longer referenced by the panel`).toBe(false);
    }
    for (const cardKey of ['approval', 'display', 'calculation']) {
      expect(panelSrc.includes(`'${cardKey}'`), `card key '${cardKey}' gone`).toBe(false);
    }
  });

  it('keeps the localStorage step keys stable (per-type section state survives the step restructure)', () => {
    // c979aa8b: the step keys ARE the old accordion card keys, declared in walk order — 'ess' deliberately
    // stays Condition's historical key so persisted state carries over. b8fcae73 shortened the walk to four
    // and reordered it (Condition ahead of Entitlement); the surviving keys are untouched.
    expect(panelSrc).toContain("const STEP_KEYS = ['general', 'ess', 'entitlement', 'custom'] as const");
    // Same per-type storage key shape as the accordion used…
    expect(panelSrc).toContain('leaveTypeCards:${id}');
    // …and an old accordion payload ({ key: boolean }) migrates (first open card wins), not discarded.
    expect(panelSrc).toContain('parsed[k] === true');
  });

  it('pins the reported en titles: Condition, Entitlement', () => {
    const msgs = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    const leave = msgs.admin.leave;
    expect(leave.categoryEssPolicy).toBe('Condition');
    expect(leave.categoryEntitlement).toBe('Entitlement');
  });

  it('has all 4 category titles (and no retired keys) in every locale', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const leave = msgs?.admin?.leave ?? {};
      for (const key of CATEGORY_KEYS) {
        expect(typeof leave[key], `${loc}.admin.leave.${key}`).toBe('string');
        expect((leave[key] as string).length, `${loc}.admin.leave.${key} non-empty`).toBeGreaterThan(0);
      }
      for (const key of RETIRED_KEYS) {
        expect(leave[key], `${loc}.admin.leave.${key} retired`).toBeUndefined();
      }
    }
  });
});

describe('123c1e76 · per-type Entitlement card reuses the benefit-scheme table (no forked config)', () => {
  it('the panel imports the shared table + type from benefit-scheme-config', () => {
    // Restructure Service-Based Leave Entitlements added ServiceEntitlementTable + ServicePolicyRow to the
    // same import; the reuse of LeaveTypeEntitlementTable + its type must remain.
    expect(panelSrc).toContain("from './benefit-scheme-config'");
    expect(panelSrc).toMatch(/import \{[\s\S]*LeaveTypeEntitlementTable[\s\S]*\} from '\.\/benefit-scheme-config'/);
    expect(panelSrc).toMatch(/import \{[\s\S]*type LeaveTypeSchemeEntitlement[\s\S]*\} from '\.\/benefit-scheme-config'/);
  });

  it('benefit-scheme-config exports the per-type table and it reuses the shared writer, not a fork', () => {
    expect(schemeSrc).toContain('export function LeaveTypeEntitlementTable');
    expect(schemeSrc).toContain('export type LeaveTypeSchemeEntitlement');
    const start = schemeSrc.indexOf('export type LeaveTypeSchemeEntitlement');
    // a03eff24 made this section a matrix whose row is its own component, so the window starts at the row
    // TYPE and stops at the banner opening the sibling company × grade table.
    const body = schemeSrc.slice(
      start,
      schemeSrc.indexOf('// ─────────────────── Service-Based Entitlements (company × grade) ───────────────────', start),
    );
    // Reuse, not re-implementation: the SAME edit dialog still opens from here for the band shapes the grid
    // cannot lay out.
    expect(body).toContain('<EntitlementEditDialog');
    // a03eff24 replaced the `tiersFromBands` read with a direct read of the row's stored bands — that reader
    // collapses any non-three-band shape to a blank 2/5 template, which is exactly what the matrix must not
    // do. So the reuse claim is now asserted where it actually lives: the inline cells post the SAME
    // upsertSchemeEntitlement FormData contract the dialog's form posts, byte for byte.
    expect(body).toContain('name="benefitSchemeId"');
    expect(body).toContain('name="leaveTypeId"');
    expect(body).toContain('name="serviceBands"');
    // …and the defensive tier reader itself is still shipped for the dialog path (not deleted).
    expect(schemeSrc).toContain('function tiersFromBands(');
  });

  it('the entitlements page feeds the panel the filtered rows and the SAME upsert action', () => {
    expect(pageSrc).toContain('schemeEntitlements={schemeEntsByType.get(lt.id) ?? []}');
    expect(pageSrc).toContain('upsertSchemeEntitlementAction={upsertSchemeEntitlementAction}');
    // Scheme-wide management still ships — since 6c775d68 as the SCOPED BenefitSchemeConfig inside each
    // type's Entitlement step (see benefit-scheme-scoped-step.test.ts), no longer as a standalone section.
    expect(pageSrc).toContain('<BenefitSchemeConfig');
  });

  it('has the per-type table strings in every locale', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const bs = msgs?.admin?.benefitScheme ?? {};
      for (const key of ['perTypeColScheme', 'perTypeEmpty', 'perTypeSharedPool', 'perTypeManageNote']) {
        expect(typeof bs[key], `${loc}.admin.benefitScheme.${key}`).toBe('string');
        expect((bs[key] as string).length, `${loc}.admin.benefitScheme.${key} non-empty`).toBeGreaterThan(0);
      }
    }
  });
});
