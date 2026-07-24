/**
 * Move Benefit Schemes into the Leave Type Entitlement step (feedback 6c775d68).
 *
 * The Benefit Schemes area (grade groups, schemes, per-scheme entitlement table with combined-limit
 * pools) no longer renders as a standalone section at the bottom of the Entitlements page. It now lives
 * INSIDE each leave type's Entitlement step (step 3 of the c979aa8b workspace), below the per-type
 * entitlement table, scoped to the selected leave type:
 *   - DISPLAY scope only: the per-scheme entitlement table lists just the selected type's row; grade-group
 *     and scheme CRUD stay full (they are structural) and every write still posts the same scheme-wide
 *     server actions — no data, combined-limit or calculation change.
 *   - Combined-limit pools spanning OTHER leave types keep rendering (header-only when their member rows
 *     are display-filtered away) and carry a "shared with <other types>" badge, so a shared-cap edit made
 *     from one type's step never surprises.
 *   - The scheme data is prepared ONCE at page level and passed into every panel as a slot (only the scope
 *     id varies) — no N+1 per type.
 *
 * Static source guard (repo convention for this DOM-runner-less feature area — see
 * leave-type-config-categories.test.ts / leave-type-workspace.test.ts). What a static test CANNOT prove —
 * editing a shared combined limit from type A being reflected on type B, drag-and-drop into a pool inside
 * the step, and the empty state for a type with no scheme rows — is assigned to browser verification.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';

const here = dirname(fileURLToPath(import.meta.url));
const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
const schemeSrc = readFileSync(resolve(here, '../components/benefit-scheme-config.tsx'), 'utf8');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

describe('6c775d68 · the standalone Benefit Schemes section is gone from the page bottom', () => {
  it('no longer renders a benefitSchemeTitle SectionHeader card', () => {
    expect(pageSrc).not.toMatch(/SectionHeader title=\{t\('benefitSchemeTitle'\)\}/);
  });

  it('composes BenefitSchemeConfig ONCE per type inside the panels map, scoped to that type', () => {
    // Exactly one <BenefitSchemeConfig …> composition remains — the per-panel scoped one. b1b81a08: the
    // gradesPanel slot is gone with the grade master's move to Settings → System Labels.
    expect(pageSrc.match(/<BenefitSchemeConfig/g)?.length).toBe(1);
    expect(pageSrc).toContain(
      '<BenefitSchemeConfig {...schemeConfigProps} scopeLeaveTypeId={lt.id} />',
    );
    // …passed into the panel through the Entitlement-step slot, headed by the kept i18n strings.
    expect(pageSrc).toContain('benefitSchemeSection={');
    expect(pageSrc).toContain("{t('benefitSchemeTitle')}");
    expect(pageSrc).toContain("{t('benefitSchemeHelp')}");
  });

  it('prepares the scheme data ONCE at page level (no N+1 per type)', () => {
    // A single shared props object; the per-type composition only varies the scope id.
    expect(pageSrc.match(/const schemeConfigProps = \{/g)?.length).toBe(1);
    // The loaders still run once in the page-level Promise.all.
    for (const loader of ['listGradeGroups(s)', 'listBenefitSchemes(s)', 'listSchemeEntitlements(s)', 'listSchemeCombinedLimits(s)']) {
      expect(pageSrc.match(new RegExp(loader.replace(/[().]/g, '\\$&'), 'g'))?.length, `${loader} loaded exactly once`).toBe(1);
    }
  });
});

describe('6c775d68 · the panel renders the scoped area inside the Entitlement step', () => {
  // 7b945408 re-pinned: the Entitlement step became a three-sub-step walk (see
  // leave-entitlement-substeps.test.ts). The scoped Benefit Schemes area now anchors sub-step 1
  // (Benefit Schemes); the per-type entitlement table moved to sub-step 2 (Service Based Entitlements).
  // b1b81a08 re-pinned again: the Grades catalogue is gone from this page entirely — grade master data is
  // maintained on Settings → System Labels → Organisation Labels (see
  // test/grade-system-label-relocation.test.ts). The scheme area still lives inside the SAME Entitlement
  // card — the single home this guard exists for.
  it('the benefitSchemeSection slot renders inside the schemes sub-step gate, before the Condition step', () => {
    const gate = panelSrc.indexOf("{entitlementSubStep === 'schemes' && (");
    const slot = panelSrc.indexOf('{benefitSchemeSection}');
    const nextGate = panelSrc.indexOf("{entitlementSubStep === 'service' && (");
    // Restructure Service-Based Leave Entitlements: the per-type benefit-scheme table (LeaveTypeEntitlementTable)
    // now lives in the Benefit Schemes sub-step (after the scheme workbench, where naming schemes is correct);
    // the Service Based Entitlements sub-step hosts the company-driven ServiceEntitlementTable.
    const schemeTable = panelSrc.indexOf('<LeaveTypeEntitlementTable');
    const serviceTable = panelSrc.indexOf('<ServiceEntitlementTable');
    const nextStep = panelSrc.indexOf("<CardTitle>{t('categoryEssPolicy')}</CardTitle>");
    expect(gate).toBeGreaterThan(-1);
    expect(slot).toBeGreaterThan(gate);
    // the benefit-scheme table follows the scheme workbench, still inside the schemes sub-step
    expect(schemeTable).toBeGreaterThan(slot);
    expect(nextGate).toBeGreaterThan(schemeTable);
    // the company-driven service table anchors the Service Based Entitlements sub-step of the same card
    expect(serviceTable).toBeGreaterThan(nextGate);
    expect(nextStep).toBeGreaterThan(serviceTable);
  });
});

describe('6c775d68 · scoped display filter — rows of other leave types hidden, guards stay scheme-wide', () => {
  it('the per-scheme table filters its rows to scopeLeaveTypeId (display only)', () => {
    expect(schemeSrc).toContain('scopeLeaveTypeId?: string');
    expect(schemeSrc).toMatch(/scopeLeaveTypeId\s*\?\s*selectedSchemeEnts\.filter\(\(e\) => e\.leaveTypeId === scopeLeaveTypeId\)\s*:\s*selectedSchemeEnts/);
  });

  it('the add-form duplicate guard reads the FULL scheme list, not the display-scoped one', () => {
    // A leave type whose row is merely hidden by the scope filter must still trip the dup guard.
    expect(schemeSrc).toContain('existingLeaveTypeIds={selectedSchemeEnts.map((e) => e.leaveTypeId)}');
  });

  it('pools whose member rows are all hidden still render (header-only), staying visible + droppable', () => {
    expect(schemeSrc).toContain('if (!byPool.has(p.id)) out.push({ pool: p, ents: [] })');
  });

  it('CRUD still writes scheme-wide: the same Actions contract, no scoped fork of any write', () => {
    // The scoped host passes the SAME actions object — every write keeps posting the scheme-wide server
    // actions (moveCombinedLimitMember still keys on benefitSchemeId, upserts still carry it, and grade
    // group / scheme management render unconditionally, i.e. not gated behind the scope flag).
    expect(schemeSrc).toContain("fd.set('benefitSchemeId', schemeId)");
    expect(schemeSrc).toContain('<input type="hidden" name="benefitSchemeId" value={schemeId} />');
    expect(schemeSrc).not.toMatch(/scopeLeaveTypeId\s*&&\s*actions\./);
    for (const structural of ['actions.createGradeGroup', 'actions.updateGradeGroup', 'actions.createScheme', 'actions.updateScheme']) {
      expect(schemeSrc.includes(structural), `${structural} still wired`).toBe(true);
    }
  });
});

describe('6c775d68 · shared combined-limit badge', () => {
  it('a pool spanning other leave types renders the sharedWithTypes badge in the scoped view', () => {
    // The badge derives from the pool members MINUS the scoped type, and only exists when scoped.
    expect(schemeSrc).toMatch(/pool\.leaveTypeIds\.filter\(\(id\) => id !== scopeLeaveTypeId\)\.map\(\(id\) => typeNames\.get\(id\) \?\? '—'\)/);
    expect(schemeSrc).toMatch(/sharedNames\.length > 0 &&[\s\S]{0,200}t\('sharedWithTypes', \{ names: sharedNames\.join\(', '\) \}\)/);
  });

  it('has the sharedWithTypes string ({names} param) in every locale, and en names the pool-wide effect', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(here, `../messages/${loc}.json`), 'utf8'));
      const val = msgs?.admin?.benefitScheme?.sharedWithTypes;
      expect(typeof val, `${loc}.admin.benefitScheme.sharedWithTypes`).toBe('string');
      expect(val as string, `${loc}: keeps the {names} interpolation`).toContain('{names}');
    }
    const en = JSON.parse(readFileSync(resolve(here, '../messages/en.json'), 'utf8'));
    const t = createTranslator({ locale: 'en', messages: en, namespace: 'admin.benefitScheme' }) as unknown as (
      k: string,
      p?: Record<string, unknown>,
    ) => string;
    expect(t('sharedWithTypes', { names: 'Sick Leave, Hospitalization' })).toBe(
      'Shared with Sick Leave, Hospitalization — edits here affect every leave type in this pool',
    );
  });
});
