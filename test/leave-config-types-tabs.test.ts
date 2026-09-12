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
import { leavePack } from '../packs/leave';

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
/**
 * a6fe37fc ROUND 5 (cutover) — THE OLD PANEL IS DELETED, so the pair-wise comparisons below have nothing
 * to compare against and become one-sided assertions about the surviving screen.
 *
 * Round 2 built this screen ALONGSIDE `components/leave-type-panel.tsx` and several cases here pinned
 * that the two agreed — a field rendered on one and not the other would have been a setting that saved
 * differently depending on which screen you used. That risk is gone with the second screen: there is one
 * editor now. The assertions are kept and narrowed rather than deleted, because what they really pin is
 * "this screen renders no editor for a field the action treats as absent", which is still true and still
 * worth failing on.
 */
const OLD_PANEL_DELETED = true;
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

/**
 * Rule 1, ONE LEVEL DOWN — and this is the level the defect lives at.
 *
 * ⚠️ THE FIRST DRAFT OF THIS FILE STOPPED ONE LEVEL ABOVE THE FAILURE IT EXISTS TO CATCH. It pinned that
 * every form posts its marker, its `id` and its hidden `name` — but not that the form still posts the
 * FIELDS the marker's branch in `updateLeaveTypeAction` reads. That gap is not academic: renaming the
 * shipped `name="hrRemarkRequired"` to `hrRemarkRequiredXX` left this suite 87/87 GREEN and `tsc` clean,
 * while every save of the document form would have written `hr_remark_required = false` — the marker is
 * present, so the branch runs, and an absent checkbox reads as OFF. "It saves, and it wipes its own
 * column", which is precisely the class the round was briefed to make impossible.
 *
 * So: for each marker, the fields its branch actually reads, checked against the FORM THAT CARRIES IT
 * rather than against the two files as a whole — a field that drifts into a neighbouring form is posted
 * on the wrong save and is exactly as lost.
 *
 * The table is kept honest in BOTH directions: every entry must also be a field `app/admin/actions.ts`
 * really reads (second case), and every marker on the screen must appear in the table (third case), so
 * neither a stale row nor a new marker with no row can sit here unnoticed.
 */
const actionsSrc = read('app/admin/actions.ts');

/** A field one marker's branch reads: how it appears in the form, and how the action reads it. */
type PostedField = { label: string; inForm: RegExp; inAction: RegExp };

/** `name="x"`, read as `fd.get('x')` / `formData.getAll('x')` / the rules action's `num('x')`. */
const posted = (name: string): PostedField => ({
  label: `name="${name}"`,
  inForm: new RegExp(`name="${name}"`),
  inAction: new RegExp(`(?:\\.get(?:All)?|num)\\('${name}'\\)`),
});

/** A field rendered once per key — `name={`prefix_${k}suffix`}`, read the same way in the action. */
const postedPerKey = (prefix: string, suffix = ''): PostedField => ({
  label: `name={\`${prefix}\${…}${suffix}\`}`,
  inForm: new RegExp('name=\\{`' + prefix + '\\$\\{[^}]+\\}' + suffix + '`\\}'),
  inAction: new RegExp('\\.get\\(`' + prefix + '\\$\\{[^}]+\\}' + suffix + '`\\)'),
});

/** The eight organisation-assignment pickers: one descriptor drives the form AND the action's loop. */
const ORG_PICKERS: PostedField = {
  label: 'the ORG_ASSIGNMENT_CRITERIA pickers (name={c.key})',
  inForm: /ORG_ASSIGNMENT_CRITERIA\.map\([\s\S]*?name=\{c\.key\}/,
  inAction: /getAll\(c\.key\)/,
};

/** Marker → every field its branch reads. Derived from app/admin/actions.ts, branch by branch. */
const MARKER_FIELDS: Record<(typeof MARKERS)[number], PostedField[]> = {
  // updateLeaveTypeAction — `identityFields` also carries the audit `reason`, which the action reads on
  // EVERY save but only this form renders.
  identity: [posted('description'), posted('paid'), posted('code'), posted('reason')],
  leaveUnit: [posted('leaveUnitValue')],
  yearCycle: [posted('yearCycleValue')],
  visibility: [posted('employeeCanApply')],
  placement: [posted('placementValue')],
  visual: [posted('color'), posted('icon')],
  essView: [postedPerKey('essView_')],
  formula: [postedPerKey('formula_', '_description'), postedPerKey('formula_', '_formula')],
  payrollImpact: [posted('sendToPayroll')],
  eligibility: [
    posted('gender'),
    posted('maritalStatus'),
    posted('minServiceMonths'),
    posted('minServiceUnit'),
    posted('probation'),
    ORG_PICKERS,
  ],
  // setLeaveTypeRulesAction — the earning half and the rounding half ride two markers on ONE form.
  earningRendered: [posted('method'), posted('accrualDay')],
  roundingMethodRendered: [posted('roundingMethod'), posted('roundingBands')],
  carryBlockRendered: [
    posted('carryForwardEnabled'),
    posted('carryForwardMax'),
    posted('carryForwardPercent'),
    posted('carryForwardExpiryMode'),
    posted('carryForwardExpiryMonths'),
    posted('carryForwardExpiryMonth'),
    posted('carryForwardExpiryDay'),
    posted('carryForwardIncludeEarned'),
  ],
  negativeBalance: [posted('allowNegativeBalanceValue'), posted('maxNegativeBalance')],
  balanceSource: [posted('balanceSourceMode'), posted('balanceSourceTypeId')],
  allowUpl: [posted('allowUnpaidLeaveValue')],
  durations: [posted('duration')],
  document: [
    posted('requiresDocument'),
    posted('mandatoryAfterDays'),
    posted('allowedMimeType'),
    posted('maxFileSizeMb'),
    posted('employeeRemarkRequired'),
    posted('hrRemarkRequired'),
  ],
  applicationLimits: [posted('maxDaysPerLeaveYear'), posted('maxDaysPeriod')],
  maxConsecutive: [posted('maxConsecutiveDays'), posted('maxConsecutiveUnit')],
  // Each rule's custom message rides ITS OWN rule's marker — one sub-form, one atomic save.
  backdating: [posted('backdatingLimitDays'), posted('customMessageBackdating')],
  minAdvance: [posted('minAdvanceDays'), posted('minAdvanceDayType'), posted('customMessageMinAdvance')],
  overrideRules: [postedPerKey('override_'), postedPerKey('overrideOn_')],
  duplicatePolicy: [posted('duplicatePolicyValue')],
  dayTypeInclusion: [postedPerKey('dayType_')],
  applyNotice: [posted('enableApplyNotice'), posted('customMessageApplyNotice')],
  partialApproval: [posted('perDateApproval')],
};

/**
 * A form's SCOPE is its body plus the source of every component it mounts (transitively). Three of these
 * forms render their fields through a local helper — RoundingBandsEditor, CarryExpiryFields,
 * ViewConfigExplanationFields — and a body-only scan would call those fields missing.
 */
const COMPONENT_SOURCE = new Map<string, string>(
  [tabsSrc, formsSrc].flatMap((src) => {
    const decls = [...src.matchAll(/^(?:export )?function ([A-Z][A-Za-z0-9]*)\s*\(/gm)];
    return decls.map(
      (d, i) =>
        [d[1], src.slice(d.index!, i + 1 < decls.length ? decls[i + 1].index! : src.length)] as [string, string],
    );
  }),
);

function withMountedComponents(body: string, seen = new Set<string>()): string {
  let out = body;
  for (const m of body.matchAll(/<([A-Z][A-Za-z0-9]*)/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const block = COMPONENT_SOURCE.get(m[1]);
    if (block) out += `\n${withMountedComponents(block, seen)}`;
  }
  return out;
}

/** Every `<form>` in the two new files, each with its mounted components folded in. */
const FORM_SCOPES = [tabsSrc, formsSrc].flatMap((src) =>
  src
    .split('<form')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf('</form>')))
    .map((body) => ({ body, scope: withMountedComponents(body) })),
);

const scopeCarrying = (marker: string): string | null =>
  FORM_SCOPES.find((f) => f.body.includes(`name="${marker}" value="1"`))?.scope ?? null;

describe('a6fe37fc R2 · rule 1 one level down — the marker’s form still posts the fields its branch READS', () => {
  it.each(Object.entries(MARKER_FIELDS))('the %s form posts every field its branch reads', (marker, fields) => {
    const scope = scopeCarrying(marker);
    expect(scope, `no form in the new screen carries the ${marker} marker`).not.toBeNull();
    for (const field of fields) {
      expect(
        field.inForm.test(scope!),
        `the form carrying '${marker}' no longer posts ${field.label}, and updateLeaveTypeAction/` +
          `setLeaveTypeRulesAction still READS it under that marker — every save through this form would ` +
          `write the absent reading (false / null / cleared) over whatever is stored`,
      ).toBe(true);
    }
  });

  it('every field in the table is one app/admin/actions.ts actually reads', () => {
    for (const [marker, fields] of Object.entries(MARKER_FIELDS)) {
      for (const field of fields) {
        expect(
          field.inAction.test(actionsSrc),
          `${marker} · ${field.label} is not read by app/admin/actions.ts — the table has gone stale, which ` +
            `makes the case above assert a field nothing consumes`,
        ).toBe(true);
      }
    }
  });

  it('the table covers every marker on the screen — a new marker cannot arrive without its fields', () => {
    expect(Object.keys(MARKER_FIELDS).sort()).toEqual([...MARKERS].sort());
  });

  it('the two fields the action reads and NO editor renders are absent HERE exactly as they are there', () => {
    // `roundingThreshold` (8fec719e retired the control) and `maxBalanceDays` (never had one on this
    // screen) are read by setLeaveTypeRulesAction but rendered by neither editor: absence means CLEAR for
    // the first and PRESERVE for the second, and that is today's behaviour on both screens. Pinned as an
    // equality so the pair cannot drift apart while the two screens are live side by side.
    expect(OLD_PANEL_DELETED).toBe(true);
    for (const field of ['roundingThreshold', 'maxBalanceDays']) {
      expect(
        newScreen.includes(`name="${field}"`),
        `${field} has grown an editor on the leave type screen — absence means CLEAR for roundingThreshold ` +
          `and PRESERVE for maxBalanceDays, so adding a control changes what a save does to a stored value`,
      ).toBe(false);
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

  it('each of the two settings now has exactly ONE editor, and it is on this screen', () => {
    // ROUND 2: "NEITHER old screen loses its copy this round" — a setting editable in two places for one
    // round was the deliberate price of "something works at every point". ROUND 5 closes that window, and
    // the case is inverted rather than deleted, because the property that matters is the one it was
    // buying time against: ONE marker, ONE column, ONE editor. Per-date approval's other copy went with
    // the leave type panel; Send to payroll module's goes with the Payroll impact screen's own commit,
    // so that half follows the same CUTOVER switch the round-3 file uses.
    expect(OLD_PANEL_DELETED).toBe(true);
    expect(newScreen.match(/name="partialApproval" value="1"/g)).toHaveLength(1);
    const payrollIsStub = payrollPageSrc.includes('redirect(');
    if (payrollIsStub) {
      expect(payrollPageSrc).not.toContain('name="sendToPayroll"');
      expect(newScreen.match(/name="payrollImpact" value="1"/g)).toHaveLength(1);
    } else {
      expect(payrollPageSrc).toContain('name="payrollImpact" value="1"');
      expect(payrollPageSrc).toContain('name="sendToPayroll"');
    }
  });
});

describe('a6fe37fc R2 · nothing on the leave type screen was dropped in the move', () => {
  // IA §3.1 maps the old screen's functions onto the new one; every one of them writes or reads a named
  // field, so the field is what a rewrite can silently lose. One representative field per function.
  //
  // ⚠️ THIS LIST IS ONLY AS COMPLETE AS THE TABLE IT IS KEYED TO, AND THE TABLE WAS NOT COMPLETE. F47 and
  // F48 below are on the old screen today and were missing from §3.1 — both landed BEFORE the design's
  // baseline (main@0c01befc) — so the first draft of this guard could not see the new screen drop them.
  // They are in §3.1 now, and they are pinned here. A function absent from the table is invisible to a
  // table-keyed guard: when a surface is found missing, the DOCUMENT is half the fix.
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

  it('F11 the entitlement tables are MOUNTED, not re-implemented; F12 run accrual left a pointer behind', () => {
    // IA §2.3: one component, two mount points. A filtered copy for the tab would be the second
    // implementation this item exists to remove.
    expect(pageSrc).toContain('<EntitlementTablesBlock');
    expect(pageSrc).toContain('leaveTypeId={leaveTypeId}');
    expect(tabsSrc).toContain('{entitlementTablesSection}');
    // 10b59703 — F12 moved to Generate Entitlement (it runs a calculation); the tab keeps a one-line
    // pointer in the slot the button occupied, resolved through the map. IA §3.1 F12 carries the date.
    expect(pageSrc).not.toContain('<EarnedAccrualDialog');
    expect(pageSrc).toContain("leaveConfigScreenHref('generateEntitlement')");
    expect(pageSrc).toContain("t('entitlementStep.accrualMovedPointer')");
    expect(pageSrc).toContain('accrualPointer={accrualPointer}');
    expect(tabsSrc).toContain('{accrualPointer}');
    expect(tabsSrc).not.toContain('{accrualSection}');
    expect(read('app/admin/leave-config/generate/page.tsx')).toContain('<EarnedAccrualDialog');
  });

  it('F2 the health derivation is read, not recomputed', () => {
    expect(pageSrc).toContain('leaveConfigHealthAll(');
    expect(pageSrc).toContain('<LeaveConfigHealthCard');
    expect(pageSrc).toContain('tablesReachNobody(h)');
  });

  it('F47 the Employee Balances way in (r242) is a Leave Config SUBMENU ROW now, at its unchanged address', () => {
    // r242 3a3f5a2d exists because an HR admin looking one person's balances up came to Leave Config and
    // found nothing pointing at Leave Inquiry. Dropping the way in re-creates that exact complaint.
    //
    // 5ca446db (r269) — UPDATED, NOT DELETED, because the DECISION being reversed is only WHERE the way in
    // lives, not whether there is one. r242 answered F47 with a single underlined link in this page's
    // header; the reporter came back and asked (for the second time) for a menu row instead. A permanent
    // row on every Leave Config screen serves F47 strictly better than one link on one page, so the
    // assertion follows the property onto the row — and the link is asserted GONE, so a half-done change
    // that removes the link without adding the row fails here.
    const ROW = leavePack.navNodes!.find((n) => n.group === 'admin')!.children.at(-1)!;
    expect(ROW.labelKey).toBe('employeeLeaveInquiry');
    expect(ROW.href, 'the address r242 promised would not move').toBe('/leave/employee-balances');
    expect(ROW.ownedSubpaths).toEqual(['/leave/employee-records']);
    expect(pageSrc).not.toContain('href="/leave/employee-balances"');
    expect(pageSrc).not.toContain("t('employeeBalancesAction')");
    expect(read('app/admin/leave-config/types/page.tsx')).not.toContain('href="/leave/employee-balances"');
  });

  it('F48 the negative-balance-needs-a-limit list (r126) survived, predicate and all', () => {
    // 9861b8a4's list of types set to allow a negative balance with NO floor: the permission the switch
    // unlocks is inert on them, and the half-made decision has to be visible somewhere page-level.
    expect(pageSrc).toContain('negativeBalanceNeedsLimit');
    expect(pageSrc).toContain("t('negativeBalanceNeedsLimitTitle')");
    expect(pageSrc).toContain("t('negativeBalanceNeedsLimitHelp')");
    // The PREDICATE, not just the card: a list built on a different rule is a different list.
    expect(pageSrc).toContain('lt.allowNegativeBalance === true && lt.maxNegativeBalance == null && !lt.archivedAt');
    // Rendered only when non-empty — a permanent empty banner is furniture, and furniture stops being read.
    expect(pageSrc).toContain('negativeBalanceNeedsLimit.length > 0 &&');
  });

  it('F6 the identity form is still behind the Rename toggle, with Discard beside Save', () => {
    // The old panel keeps a leave type's name and code read-only until an administrator asks for them
    // (components/leave-type-panel.tsx `editingName`). The first draft of this screen rendered the form
    // always-open and called that "presentation only": it is not — an always-editable name field beside a
    // Save button is a different screen to work on, and the round's framing is that only the ARRANGEMENT
    // changes. Pinned here so the toggle cannot be dropped a second time without saying so.
    expect(tabsSrc).toContain('const [editingName, setEditingName] = useState(false);');
    expect(tabsSrc).toContain('{editingName ? (');
    expect(tabsSrc).toContain("onClick={() => setEditingName(true)}");
    expect(tabsSrc).toContain("onClick={() => setEditingName(false)}");
    expect(tabsSrc).toContain("{t('rename')}");
    expect(tabsSrc).toContain("{t('discardChanges')}");
    // The gate must sit on the IDENTITY form — the one that posts `identity=1` — not on some other block.
    const open = tabsSrc.indexOf('{editingName ? (');
    const closes = tabsSrc.indexOf('</form>', open);
    const identityForm = tabsSrc.slice(open, closes);
    expect(identityForm).toContain('name="identity" value="1"');
    expect(identityForm).toContain('name="name" defaultValue={name}');
    // Discard sits INSIDE the open form; Rename sits in the closed branch after it. Either one on the
    // wrong side of that boundary is a control an administrator cannot reach.
    expect(identityForm).toContain('onClick={() => setEditingName(false)}');
    expect(tabsSrc.indexOf('onClick={() => setEditingName(true)}')).toBeGreaterThan(closes);
  });

  it('the sibling navigation and the tour anchor came across with the screen', () => {
    // Without the map this screen cannot reach any other leave-config screen at all; `current="leaveTypes"`
    // because it IS that screen — the map names screens, not addresses.
    expect(pageSrc).toContain('<LeaveConfigMap current="leaveTypes" />');
    // lib/module-tours.json → leave · config anchors on this attribute, and carrying the anchor from
    // Round 2 is what made the cutover's repoint a ONE-LINE change to that file rather than a re-scripted
    // tour. A tour step whose route no longer resolves to a screen is a tour that opens on a redirect.
    expect(pageSrc).toContain('data-tour="leave-config"');
    const tours = JSON.parse(read('lib/module-tours.json')) as Record<
      string,
      { id: string; steps: { id: string; route: string; target: string | null }[] }
    >;
    const step = Object.values(tours)
      .flatMap((m) => m.steps)
      .find((x) => x.target === '[data-tour="leave-config"]');
    expect(step, 'the leave-config tour step no longer anchors on this attribute').toBeTruthy();
    expect(step!.route).toBe('/admin/leave-config/types');
  });
});

describe('a6fe37fc R2 · the route is registered and deliberately off the menu', () => {
  it('is a declared route, so it can be granted and revoked like any screen', () => {
    expect(REGISTERED_ROUTES.has('/admin/leave-config/types')).toBe(true);
  });

  it('IS on the leave config map now — the cutover moved the menu, one entry per commit', () => {
    // ROUND 2 asserted the opposite ("the menu moves at the Round 5 cutover, not now"), which was the
    // whole point of building this screen alongside the old one. Round 5 IS that cutover, so the case is
    // inverted rather than dropped and both directions still fail loudly: a menu that never moved, and a
    // menu still naming an address that renders a redirect stub.
    const hrefs = LEAVE_CONFIG_MAP.flatMap((g) => g.items).map((i) => i.href);
    expect(hrefs).toContain('/admin/leave-config/types');
    expect(hrefs).not.toContain('/admin/leave/entitlements');
  });
});

describe('a6fe37fc R2 · every new label ships in all six locales (the r127 lesson)', () => {
  // r127 shipped this very screen with two label sets that did not exist: MISSING_MESSAGE renders behind
  // a 200 and passes tsc, the suite and next build. These files call three namespaces, so
  // i18n-coverage's static-key case skips them entirely and this is the pinning site.
  const KEYS = [
    // 10b59703 — `pageDescription` ("One leave type, five tabs…") became `rowDescription`: the heading is
    // the submenu ROW (Entitlements) now and this sentence describes the row, for all three of its tabs.
    'rowDescription',
    // `previewNote` STOOD HERE and is DELIBERATELY GONE (a6fe37fc Round 5): the paragraph saying "a
    // save made here returns you to the current screen" came off in the cutover commit, because the
    // constants now return here, and the key is pruned in all six catalogues with it.
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
