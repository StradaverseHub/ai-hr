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
    // r88/1ef1cf95 — listSchemeCombinedLimits(s) is GONE from this list: shared groups are no longer a
    // property of a benefit scheme, so the page has no scheme-level pool data to load. The remaining
    // three still load exactly once, which is what this assertion is actually about.
    for (const loader of ['listGradeGroups(s)', 'listBenefitSchemes(s)', 'listSchemeEntitlements(s)']) {
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

  it('the scheme screen no longer renders pools at all (they moved to leave type level)', () => {
    // INVERTED IN r88 (1ef1cf95). Was: "pools whose member rows are all hidden still render (header-only),
    // staying visible + droppable" — a rule about how the scheme-scoped view presented a pool. There is no
    // pool on this screen now, so the honest assertion is that the whole concept has left it. The shared
    // group and its members are configured in components/leave-shared-group-config.tsx and guarded by
    // test/shared-leave-group-single-mechanism.test.ts.
    expect(schemeSrc).not.toContain('byPool');
    expect(schemeSrc).not.toMatch(/pool\.leaveTypeIds/);
  });

  it('CRUD still writes scheme-wide: the same Actions contract, no scoped fork of any write', () => {
    // The scoped host passes the SAME actions object — every write keeps posting the scheme-wide server
    // actions, and grade group / scheme management render unconditionally rather than behind the scope flag.
    //
    // r88/1ef1cf95 — the fd.set('benefitSchemeId', schemeId) assertion is dropped: it belonged to the DRAG
    // handler, which built FormData by hand for moveCombinedLimitMember. That entrypoint went with the
    // pool. The hidden input below is the one that matters and it is untouched, so scheme-wide writing —
    // this assertion's actual subject — is still proven.
    expect(schemeSrc).toContain('<input type="hidden" name="benefitSchemeId" value={schemeId} />');
    expect(schemeSrc).not.toMatch(/scopeLeaveTypeId\s*&&\s*actions\./);
    for (const structural of ['actions.createGradeGroup', 'actions.updateGradeGroup', 'actions.createScheme', 'actions.updateScheme']) {
      expect(schemeSrc.includes(structural), `${structural} still wired`).toBe(true);
    }
  });
});

// ── r88 / 1ef1cf95 ───────────────────────────────────────────────────────────────────────────────────
// WAS: describe('6c775d68 · shared combined-limit badge'). The badge said "Shared with Sick Leave,
// Hospitalization — edits here affect every leave type in this pool", rendered on a scheme's scoped
// entitlement rows. It cannot survive here: the pool it described was a property of the BENEFIT SCHEME,
// and shared groups are now tenant-level and configured on the leave type.
//
// THIS IS A REAL LOSS OF AWARENESS, NOT JUST A MOVED STRING, and it is recorded rather than quietly
// dropped. The badge existed so that editing a shared total from one leave type could not silently move
// another. That hazard did not go away — it got WIDER, because a group is no longer scoped to one
// scheme. Re-earning it means surfacing group membership on the entitlement rows from the new
// leave_shared_group tables, which is beyond what the approved plan asked for. Raised as follow-up debt
// in HANDOFF and stated to the reporter in the build_ref.
describe('1ef1cf95 · the scheme screen no longer claims anything about shared pools', () => {
  it('the retired badge and its string are gone from this surface, not left dangling', () => {
    expect(schemeSrc).not.toContain("t('sharedWithTypes'");
    // Scoped to the BADGE's own derivation (pool members minus the scoped type). NOT to `scopeLeaveTypeId`
    // generally — my first attempt forbade that token outright and caught the scoped-display FILTER
    // (6c775d68), which is a different, surviving feature. Forbidding a token used by something that
    // still works is the over-broad-guard mistake this round has now made three times.
    expect(schemeSrc).not.toMatch(/pool\.leaveTypeIds\.filter\(\(id\) => id !== scopeLeaveTypeId\)/);
  });

  it('the shared-group surface that REPLACED it exists and names its members', () => {
    // The awareness has to live somewhere. Today that somewhere is the group editor itself, which lists
    // every member leave type — so a shared total is never edited without its members on screen.
    const groupSrc = readFileSync(resolve(here, '../components/leave-shared-group-config.tsx'), 'utf8');
    expect(groupSrc).toContain("t('membersLabel')");
    expect(groupSrc).toContain("t('membersSummary'");
  });
});
