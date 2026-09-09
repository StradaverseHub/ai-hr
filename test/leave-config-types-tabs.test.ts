/**
 * a6fe37fc ROUND 2 — the NEW leave type screen (`/admin/leave-config/types`), five tabs, built
 * ALONGSIDE `/admin/leave/entitlements` and replacing nothing yet.
 *
 * ⚠️ THE FIRST CASE IN THIS FILE IS THE TRIPWIRE THAT DID NOT EXIST, AND THE ROUND HAD TO WRITE IT.
 * `test/leave-type-config-categories.test.ts` asserted that the retired accordion keys `approval`,
 * `display` and `calculation` never reappear as storage keys — re-using one makes an administrator's
 * stored `leaveTypeCards:<id>` payload hydrate onto the WRONG tab — and it was DELETED in `c9e18c7e`.
 * Of the 29 test files that read `components/leave-type-panel.tsx`, none carries its case. So nothing
 * would have caught a wrong key on the new screen: `tsc`, the targeted tests, `next build` and the full
 * gate all pass with one. That is what the first describe block is, written against the new file.
 *
 * The rest pins the three rules the rewrite obeys (migration order, Round 2):
 *   1. every sub-form keeps its tri-state marker and its hidden `name` — a form that posts
 *      `updateLeaveTypeAction` without its marker does not fail to save, it saves and WIPES the columns
 *      a neighbouring form owns;
 *   2. no server action changed signature and no new action was written;
 *   3. the left rail is re-created, not dropped.
 * …plus the two settings that move in, the old screens that keep their copy for one round, and the six
 * locales the r127 lesson says must be pinned somewhere (these files are multi-namespace, which is
 * exactly what i18n-coverage's static-key check skips).
 *
 * Static source guard — the repo convention for this DOM-runner-less feature area (the same shape as
 * leave-type-config-active-section.test.ts). Browser verification covers the interactive behaviour.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_CONFIG_MAP } from '../components/leave-config-map';
import { REGISTERED_ROUTES } from '../lib/permissions';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

const TABS = 'app/admin/leave-config/types/leave-type-tabs.tsx';
const FORMS = 'app/admin/leave-config/types/leave-type-sub-forms.tsx';
const PAGE = 'app/admin/leave-config/types/page.tsx';

const tabsSrc = read(TABS);
const formsSrc = read(FORMS);
const pageSrc = read(PAGE);
const newScreen = `${tabsSrc}\n${formsSrc}`;
/** The screens that keep their copy of a moved setting for exactly one round. */
const panelSrc = read('components/leave-type-panel.tsx');
const payrollPageSrc = read('app/admin/leave/payroll/page.tsx');

const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The tab keys as the shipped file declares them, read from source (this is a client component; the
 *  repo's convention for it is a static scan, not an import that would pull React in). */
function tabKeysFromSource(): string[] {
  const m = tabsSrc.match(/export const TAB_KEYS = \[([^\]]*)\] as const;/);
  expect(m, 'TAB_KEYS literal not found in the tabs file').not.toBeNull();
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('a6fe37fc R2 · storage-key tripwire — the guard c9e18c7e deleted, re-written for the new screen', () => {
  it('never names a tab after a RETIRED accordion key (approval · display · calculation)', () => {
    const keys = tabKeysFromSource();
    for (const retired of ['approval', 'display', 'calculation']) {
      expect(
        keys,
        `'${retired}' is a retired accordion key: a stored leaveTypeCards:<id> payload naming it would hydrate onto the wrong tab`,
      ).not.toContain(retired);
      // The literal must not appear as a storage key anywhere in the file either — a remap entry or a
      // persisted sub-key would reintroduce the collision without touching TAB_KEYS.
      expect(tabsSrc.includes(`'${retired}'`), `the literal '${retired}' appears in ${TABS}`).toBe(false);
    }
  });

  it('names the five tabs the design specifies, in the order the decisions are made', () => {
    expect(tabKeysFromSource()).toEqual([
      'identity',
      'eligibility',
      'entitlement',
      'application',
      'approvers',
    ]);
  });

  it('gates exactly one tab at a time, each on its own key', () => {
    for (const key of tabKeysFromSource()) {
      expect(tabsSrc.includes(`{activeTab === '${key}' && (`), `section for '${key}' gated by activeTab`).toBe(
        true,
      );
    }
  });
});

describe('a6fe37fc R2 · hydration — a stale browser is remapped, never snapped back to tab 1', () => {
  it('remaps every retired step / sub-step key onto a tab that exists', () => {
    const keys = new Set(tabKeysFromSource());
    // The four step keys of the old panel, plus the two retired ones the old panel could not place.
    for (const retired of ['general', 'ess', 'entitlement', 'custom', 'eligibility', 'workflow']) {
      const m = tabsSrc.match(new RegExp(`\\n\\s+${retired}: '([a-z]+)',`));
      expect(m, `no hydration remap for the retired key '${retired}'`).not.toBeNull();
      expect(keys, `'${retired}' remaps to a tab that does not exist`).toContain(m![1]);
    }
  });

  it('reads its own key first, then the old panel’s, from the SAME leaveTypeCards payload', () => {
    expect(tabsSrc).toContain('window.localStorage.getItem(`leaveTypeCards:${id}`)');
    expect(tabsSrc).toContain("typeof parsed.activeTab === 'string'");
    expect(tabsSrc).toContain("typeof parsed.activeStep === 'string'");
  });

  it('MERGES on write, so using the new screen does not reset the old one to step 1', () => {
    // Both screens are live until Round 5. Replacing the object here would drop activeStep /
    // generalSubStep / essSubStep, and an administrator going back would land on step 1 every time.
    const persist = tabsSrc.slice(tabsSrc.indexOf('const selectTab ='));
    expect(persist).toContain('...base');
    expect(persist).toContain('activeTab: key');
  });
});

/**
 * Rule 1. Every marker `app/admin/actions.ts` reads for a leave type, and the sub-form that owns it.
 * IA §1.2 counts 26 markers across the old panel's 23 forms plus one on the Payroll impact screen; all
 * 27 are re-rendered here, none merged and none split.
 */
const MARKERS = [
  // TAB 1 — the leave type
  'identity',
  'leaveUnit',
  'yearCycle',
  'visibility',
  'placement',
  'visual',
  'essView',
  'formula',
  'payrollImpact',
  // TAB 2 — who is eligible
  'eligibility',
  // TAB 3 — what they are entitled to
  'earningRendered',
  'roundingMethodRendered',
  'carryBlockRendered',
  'negativeBalance',
  'balanceSource',
  'allowUpl',
  // TAB 4 — how it is applied for
  'durations',
  'document',
  'applicationLimits',
  'maxConsecutive',
  'backdating',
  'minAdvance',
  'overrideRules',
  'duplicatePolicy',
  'dayTypeInclusion',
  'applyNotice',
  // TAB 5 — who approves it
  'partialApproval',
] as const;

describe('a6fe37fc R2 · rule 1 — every sub-form keeps its tri-state marker and its hidden name', () => {
  it.each(MARKERS)('posts the %s marker', (marker) => {
    expect(newScreen).toContain(`<input type="hidden" name="${marker}" value="1" />`);
  });

  it('renders 27 markers and no more — nothing was merged into a neighbour', () => {
    const count = [...newScreen.matchAll(/name="[a-zA-Z]+" value="1"/g)].length;
    expect(count, 'a marker was added, dropped or merged').toBe(MARKERS.length);
  });

  it('every form posting a leave-type action carries a marker, an id and the name', () => {
    // Split on the form openings; each chunk up to its </form> is one form body (no nesting here).
    const bodies = tabsSrc
      .split('<form')
      .slice(1)
      .map((chunk) => chunk.slice(0, chunk.indexOf('</form>')));
    const configForms = bodies.filter((b) => b.includes('updateTypeAction'));
    // The tabs file writes leave-type CONFIGURATION through updateTypeAction; the archive / delete forms
    // post their own actions and deliberately carry no marker (they touch no configuration column).
    expect(configForms.length, 'expected the configuration forms to be found').toBeGreaterThan(10);
    for (const body of configForms) {
      expect(body).toContain('value="1"');
      expect(body).toContain('name="id"');
      // The hidden `name` is half of the contract: updateLeaveTypeAction always writes it, so a form
      // that omits it renames the leave type to an empty string on every save.
      expect(body).toContain('name="name"');
    }
    // The rules forms post the OTHER action and identify the type by leaveTypeId instead.
    for (const body of formsSrc
      .split('<form')
      .slice(1)
      .map((c) => c.slice(0, c.indexOf('</form>')))
      .filter((b) => b.includes('name="leaveTypeId"'))) {
      expect(body).toContain('value="1"');
    }
  });
});

describe('a6fe37fc R2 · rule 2 — no new server action, no changed signature', () => {
  it('posts only the four existing leave-type actions', () => {
    for (const action of [
      'updateLeaveTypeAction',
      'archiveLeaveTypeAction',
      'deleteLeaveTypeAction',
      'setLeaveTypeRulesAction',
      'createLeaveTypeAction',
    ]) {
      expect(pageSrc).toContain(action);
    }
    // Nothing under the new route defines a server action of its own.
    expect(pageSrc.includes("'use server'"), 'the new page must not declare server actions').toBe(false);
    expect(tabsSrc.includes("'use server'")).toBe(false);
  });
});

describe('a6fe37fc R2 · rule 3 — the left rail is re-created, not dropped', () => {
  it('mounts the leave type list, the per-type tabs and the add form', () => {
    expect(pageSrc).toContain('<LeaveTypeWorkspace');
    expect(pageSrc).toContain('panels={Object.fromEntries(');
    expect(pageSrc).toContain('<LeaveTypeTabs');
    const addFormIdx = pageSrc.indexOf('addForm={');
    expect(addFormIdx).toBeGreaterThan(-1);
    expect(pageSrc.indexOf('action={createLeaveTypeAction}', addFormIdx)).toBeGreaterThan(addFormIdx);
  });

  it('does not import the old panel — the file Round 5 deletes', () => {
    // An IMPORT, not a mention: the doc comments name that file deliberately, and a source scan does not
    // strip comments (the pack-drift ratchet's documented false positive, generalised).
    const imports = (src: string) => [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const [file, src] of [
      [PAGE, pageSrc],
      [TABS, tabsSrc],
      [FORMS, formsSrc],
    ] as const) {
      expect(
        imports(src).filter((p) => p.includes('leave-type-panel')),
        `${file} must not depend on the panel Round 5 deletes`,
      ).toEqual([]);
    }
  });
});

describe('a6fe37fc R2 · the two settings that move onto the leave type', () => {
  it('Send to payroll module is on tab 1, with its marker and its field', () => {
    const tab1 = tabsSrc.slice(
      tabsSrc.indexOf("{activeTab === 'identity' && ("),
      tabsSrc.indexOf("{activeTab === 'eligibility' && ("),
    );
    expect(tab1).toContain('name="payrollImpact" value="1"');
    expect(tab1).toContain('name="sendToPayroll"');
  });

  it('Per-date approval is on tab 5, with its marker and its field', () => {
    const tab5 = tabsSrc.slice(tabsSrc.indexOf("{activeTab === 'approvers' && ("));
    expect(tab5).toContain('name="partialApproval" value="1"');
    expect(tab5).toContain('name="perDateApproval"');
  });

  it('NEITHER old screen loses its copy this round', () => {
    // A setting editable in two places for one round is deliberate — both write the same column through
    // the same action and the same marker, and Round 5 is where the old editor goes.
    expect(panelSrc).toContain('name="partialApproval" value="1"');
    expect(payrollPageSrc).toContain('name="payrollImpact" value="1"');
    expect(payrollPageSrc).toContain('name="sendToPayroll"');
  });
});

describe('a6fe37fc R2 · nothing on the leave type screen was dropped in the move', () => {
  // IA §3.1 maps 32 functions off the old screen; every one of them writes or reads a named field, so
  // the field is what a rewrite can silently lose. One representative field per function.
  it.each([
    ['F6 details', 'name="description"'],
    ['F6 leave unit', 'name="leaveUnitValue"'],
    ['F8 leave year type', 'name="yearCycleValue"'],
    ['F9 earning method', 'name="method"'],
    ['F9 accrual day', 'name="accrualDay"'],
    ['F9 rounding', 'name="roundingMethod"'],
    ['F9 rounding table', 'name="roundingBands"'],
    ['F10 carry forward', 'name="carryForwardMax"'],
    ['F10 carry expiry', 'name="carryForwardExpiryMode"'],
    ['F13 eligibility gate', 'name="minServiceMonths"'],
    ['F13 probation', 'name="probation"'],
    ['F14 durations', 'name="duration"'],
    ['F15 document', 'name="requiresDocument"'],
    ['F15 file types', 'name="allowedMimeType"'],
    ['F16 backdating', 'name="backdatingLimitDays"'],
    ['F17 advance notice', 'name="minAdvanceDays"'],
    ['F17 notice unit', 'name="minAdvanceDayType"'],
    ['F18 year cap', 'name="maxDaysPerLeaveYear"'],
    ['F18 cap period', 'name="maxDaysPeriod"'],
    ['F19 consecutive cap', 'name="maxConsecutiveDays"'],
    ['F20 negative balance', 'name="allowNegativeBalanceValue"'],
    ['F20 negative floor', 'name="maxNegativeBalance"'],
    ['F21 balance source', 'name="balanceSourceMode"'],
    ['F22 unpaid leave', 'name="allowUnpaidLeaveValue"'],
    ['F23 duplicate policy', 'name="duplicatePolicyValue"'],
    ['F24 day types', 'name={`dayType_${k}`}'],
    ['F25 override rules', 'name={`override_${row.trigger}`}'],
    ['F27 employee may apply', 'name="employeeCanApply"'],
    ['F28 placement', 'name="placementValue"'],
    ['F29 backdating message', 'name="customMessageBackdating"'],
    ['F29 notice message', 'name="customMessageMinAdvance"'],
    ['F29 apply-time message', 'name="customMessageApplyNotice"'],
    ['F30 employee view config', 'name={`essView_${key}`}'],
    ['F31 formula explanations', 'name={`formula_${fieldKey}_description`}'],
    ['F32 visual', 'name="icon"'],
  ])('%s survived the move (%s)', (_fn, field) => {
    expect(newScreen).toContain(field);
  });

  it('F11 the entitlement tables and F12 run accrual are MOUNTED, not re-implemented', () => {
    // IA §2.3: one component, two mount points. A filtered copy for the tab would be the second
    // implementation this item exists to remove.
    expect(pageSrc).toContain('<EntitlementTablesBlock');
    expect(pageSrc).toContain('leaveTypeId={leaveTypeId}');
    expect(pageSrc).toContain('<EarnedAccrualDialog');
    expect(tabsSrc).toContain('{entitlementTablesSection}');
    expect(tabsSrc).toContain('{accrualSection}');
  });

  it('F2 the health derivation is read, not recomputed', () => {
    expect(pageSrc).toContain('leaveConfigHealthAll(');
    expect(pageSrc).toContain('<LeaveConfigHealthCard');
    expect(pageSrc).toContain('tablesReachNobody(h)');
  });
});

describe('a6fe37fc R2 · the route is registered and deliberately off the menu', () => {
  it('is a declared route, so it can be granted and revoked like any screen', () => {
    expect(REGISTERED_ROUTES.has('/admin/leave-config/types')).toBe(true);
  });

  it('is NOT on the leave config map — the menu moves at the Round 5 cutover, not now', () => {
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.href);
    expect(hrefs).not.toContain('/admin/leave-config/types');
    // …and the old screen is still the one the menu names.
    expect(hrefs).toContain('/admin/leave/entitlements');
  });
});

describe('a6fe37fc R2 · every new label ships in all six locales (the r127 lesson)', () => {
  // r127 shipped this very screen with two label sets that did not exist: MISSING_MESSAGE renders behind
  // a 200 and passes tsc, the suite and next build. These files call three namespaces, so
  // i18n-coverage's static-key case skips them entirely and this is the pinning site.
  const KEYS = [
    'pageDescription',
    'previewNote',
    'tabsLabel',
    'tab.identity',
    'tab.eligibility',
    'tab.entitlement',
    'tab.application',
    'tab.approvers',
    'tabHint.identity',
    'tabHint.eligibility',
    'tabHint.entitlement',
    'tabHint.application',
    'tabHint.approvers',
  ];
  it.each(LOCALES)('%s carries every admin.leaveConfigTypes key with real text', async (loc) => {
    const messages = (await import(`../messages/${loc}.json`)).default as Record<string, unknown>;
    const ns = (messages.admin as Record<string, unknown>).leaveConfigTypes as Record<string, unknown>;
    expect(ns, `admin.leaveConfigTypes missing from ${loc}.json`).toBeTruthy();
    for (const key of KEYS) {
      const value = key
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ns);
      expect(typeof value, `${loc} · ${key}`).toBe('string');
      expect((value as string).trim().length, `${loc} · ${key} is blank`).toBeGreaterThan(0);
    }
  });

  it('the five tab keys and the message keys are the same five names', () => {
    const en = JSON.parse(read('messages/en.json')) as {
      admin: { leaveConfigTypes: { tab: Record<string, string>; tabHint: Record<string, string> } };
    };
    const keys = tabKeysFromSource();
    expect(Object.keys(en.admin.leaveConfigTypes.tab).sort()).toEqual([...keys].sort());
    expect(Object.keys(en.admin.leaveConfigTypes.tabHint).sort()).toEqual([...keys].sort());
  });
});
