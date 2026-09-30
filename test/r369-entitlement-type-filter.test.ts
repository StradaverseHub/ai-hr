/**
 * 3a4efe9f (r369) — THE LEAVE TYPE FILTER ON THE ENTITLEMENT TABLES TAB, AND WHY IT HAD TO COME FIRST.
 *
 * THE ITEM. HR admins could create and edit the same entitlement table from two screens — the Entitlement
 * tables tab and a leave type's "What are they entitled to" tab — and believed they had to do both. One
 * stored record, one component, one write path; two sets of buttons. The agreed fix moves table editing onto
 * the Entitlement tables tab alone.
 *
 * ⚠️ WHAT THIS FILE IS ACTUALLY PROTECTING, AND IT IS NOT A FILTER CONTROL. Moving the create form loses a
 * warning unless the destination can be narrowed to one leave type first. The warning is the one that fires
 * when a SECOND entitlement table is added to a leave type that had exactly one: with one table in force and
 * no eligibility rule, the engine hands that table to everybody (the r193 fault-3 sole-table fallback).
 * Adding a second ENDS that fallback, and from the save NEITHER table resolves for anybody until a rule or a
 * default table names one. It can only be worded when the screen knows which leave type the operator is
 * typing a table for — r224's own comment says so: "the unfiltered screen cannot know which leave type the
 * picker below is about to name."
 *
 * So the order of this round's two commits is a correctness property, not tidiness. Build the filter second
 * and there is a window in which the Entitlement tables tab owns the create form, cannot name a leave type,
 * and therefore ships entitlement configurations that silently reach nobody. §1 and §2 below are the halves
 * of that argument: §2 that the reaches-nobody state is reported at all, §1 that the filter is what makes
 * the report expressible on this screen.
 *
 * ⚠️ §3 IS A SOURCE GUARD OVER COMMENT-STRIPPED SOURCE. This block is a server component that imports a
 * 'use server' module and cannot be mounted in vitest (the reason every existing guard over it is a source
 * guard — see test/r279-balance-health-row.test.ts's note on why no rendered-markup test can see tab 3).
 * Comments are stripped first because two guards in this repo were caught green on prose that merely quoted
 * the string they were looking for.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { resolveViewLeaveTypeId } from '../lib/entitlement-tables-scope';
import { leaveTypeConfigHealth, newTableReachesNobody } from '../lib/leave-config-health';
import { todayInKualaLumpur } from '../lib/hr-date';
import type { HealthLeaveType, HealthRule, HealthTemplate } from '../lib/leave-config-health';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const BLOCK = '/app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';
const STANDALONE = '/app/admin/leave-config/entitlement-tables/page.tsx';
const TYPES_PAGE = '/app/admin/leave-config/types/page.tsx';
const SCOPE = '/lib/entitlement-tables-scope.ts';

/** COMMENTS ARE NOT CODE (the r134 rule). Every claim here explains itself by naming what it is about, and a
 *  bare-substring check over raw source would go green on the explanation instead of the code. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[^\n]*?\/\/[^\n]*$/gm, '');

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const catalogue = (loc: string) => JSON.parse(read(`/messages/${loc}.json`));

const TYPES = [
  { id: 'annual', name: 'Annual Leave' },
  { id: 'medical', name: 'Medical Leave' },
  { id: 'archived-study', name: 'Study Leave' },
] as const;

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §1 · which leave type is in view — the host's, the operator's, or none
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§1 · resolveViewLeaveTypeId — the operator filter produces a SCOPE, which is what the warning needs', () => {
  it('no host and no filter ⇒ NO scope: the tab keeps its every-type-side-by-side default', () => {
    // The one thing this screen does that a leave type's own tab 3 cannot, and the decision the two
    // anti-filter guards pin. It is not reversed: it is the default.
    expect(resolveViewLeaveTypeId({ known: TYPES })).toBeUndefined();
    expect(resolveViewLeaveTypeId({ typeFilter: undefined, known: TYPES })).toBeUndefined();
  });

  it('a filter naming a live leave type ⇒ THAT type is in view — the precondition for the reach warning', () => {
    // ⚠️ THE LOAD-BEARING CASE OF THIS FILE. If this resolves to undefined the create form on the
    // Entitlement tables tab cannot name a leave type, so the create-time reach warning is unwordable and a
    // second table that reaches nobody is added in silence.
    expect(resolveViewLeaveTypeId({ typeFilter: 'annual', known: TYPES })).toBe('annual');
  });

  it('the “All leave types” option posts an EMPTY value, and that clears the filter', () => {
    // The way out of a filter has to be the way into it, or an operator who narrows the screen cannot widen
    // it again without editing the URL by hand.
    expect(resolveViewLeaveTypeId({ typeFilter: '', known: TYPES })).toBeUndefined();
  });

  it('an id naming NO live leave type falls back to every type, never to an empty screen', () => {
    // A bookmark written before a leave type was deleted. Scoping to a type that cannot be found is the r270
    // edge case that rendered an empty "No active leave types" card AND dropped the Leave type column, so
    // the screen looked broken rather than stale.
    expect(resolveViewLeaveTypeId({ typeFilter: 'deleted-long-ago', known: TYPES })).toBeUndefined();
  });

  it('the HOST wins: a leave type tab cannot be re-filtered out from under its own heading', () => {
    // tab 3 is about one leave type by construction. A query parameter that widened or moved it would
    // contradict the heading directly above it.
    expect(resolveViewLeaveTypeId({ leaveTypeId: 'annual', typeFilter: 'medical', known: TYPES })).toBe('annual');
    expect(resolveViewLeaveTypeId({ leaveTypeId: 'annual', known: [] })).toBe('annual');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §2 · a configuration that reaches NOBODY is reported — the fact the filter exists to keep sayable
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§2 · the reaches-nobody state, measured where the warning reads it', () => {
  // DERIVED FROM THE CLOCK, never a written date: `leaveTypeConfigHealth` decides "in force" against this
  // value, and a fixture with a hardcoded year silently stops being in force once the year passes — taking
  // the assertion with it and reporting green.
  const today = todayInKualaLumpur();
  /** A year comfortably behind `today`, so every fixture table below is in force whenever this runs. */
  const longAgo = `${Number(today.slice(0, 4)) - 6}-01-01`;
  const leaveType = (over: Partial<HealthLeaveType> = {}): HealthLeaveType => ({
    id: 'annual',
    name: 'Annual Leave',
    accrualMethod: 'monthly',
    accrualUnconfigured: false,
    daysFromLeaveCreditOnly: false,
    defaultEntitlementTemplateLineageId: null,
    // r299 (3de1453a) — REQUIRED, not optional, for the reason the type's own note gives: a flag a
    // projection forgets defaults to "no finding", and the finding goes quiet behind a green suite.
    earnedMethodNotAnnualLeave: false,
    archived: false,
    ...over,
  });
  const table = (lineageId: string): HealthTemplate => ({
    lineageId,
    leaveTypeId: 'annual',
    name: `Table ${lineageId}`,
    validFrom: longAgo,
    validTo: null,
    serviceBands: [{ days: 14 }],
  });
  const rule = (templateLineageId: string): HealthRule => ({
    lineageId: `rule-for-${templateLineageId}`,
    name: 'Everyone',
    templateLineageId,
    validFrom: longAgo,
    validTo: null,
    criteria: {},
  });
  const health = (templates: HealthTemplate[], rules: HealthRule[], over?: Partial<HealthLeaveType>) =>
    leaveTypeConfigHealth({ leaveType: leaveType(over), templates, rules, grades: [], today });

  it('ONE table and no rule: the sole-table fallback hands it to everybody — and a second table would end that', () => {
    const h = health([table('lin-a')], []);
    expect(h.soleTableApplies, 'one table, no rule ⇒ the fallback is what is reaching people').toBe(true);
    expect(newTableReachesNobody(h), 'so typing a SECOND table here must be warned about').toBe(true);
  });

  it('TWO tables, no rule, no default: NEITHER table reaches anybody, and that is reported', () => {
    // ⚠️ THE STATE THE WARNING EXISTS FOR, and the one this round could have started shipping silently. The
    // fallback is gone (two tables, so nothing to choose between), no rule points at either, and no default
    // catches the remainder — so the leave type grants nothing at all.
    const h = health([table('lin-a'), table('lin-b')], []);
    expect(h.soleTableApplies, 'a second table ENDS the sole-table fallback').toBe(false);
    expect(h.defaultTableApplies, 'and no default table is catching the remainder').toBe(false);
    expect(h.noRuleInForce, 'and no eligibility rule points at either table').toBe(true);
    expect(newTableReachesNobody(h), 'a configuration reaching nobody must be reported, not inferred').toBe(true);
  });

  it('a default table in force is a THIRD answer, not a fourth warning', () => {
    // With a default named, everybody no rule covers still resolves, so the new table is simply one more
    // table nobody is pointed at yet. The screen says that in its own words rather than crying wolf.
    const h = health([table('lin-a'), table('lin-b')], [], { defaultEntitlementTemplateLineageId: 'lin-a' });
    expect(h.defaultTableApplies).toBe(true);
    expect(newTableReachesNobody(h), 'still worth saying — but with the default-table wording').toBe(true);
  });

  it('a rule in force means a new table is ordinary: no warning on the commonest healthy shape', () => {
    // The other half of honesty. A warning that fires on every leave type is a warning nobody reads, and
    // that is how the r224 comment says the two sentences must not be flattened into one.
    const h = health([table('lin-a')], [rule('lin-a')]);
    expect(h.noRuleInForce).toBe(false);
    expect(newTableReachesNobody(h)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §3 · the wiring — the filter is what carries §1's scope into §2's warning
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§3 · the filter reaches the warning, and the standalone tab reads it from the URL', () => {
  const blockCode = stripComments(read(BLOCK));
  const standaloneCode = stripComments(read(STANDALONE));

  it('the block derives its scope from the SHARED resolver, not from an inline ?? in the component', () => {
    // A `leaveTypeId ?? typeFilter` written here would be untestable: the component cannot be mounted, so
    // the answer that decides whether the warning is wordable would be pinned by nothing at all.
    expect(read(SCOPE)).toContain('export function resolveViewLeaveTypeId');
    expect(blockCode).toContain('resolveViewLeaveTypeId({ leaveTypeId, typeFilter, known: leaveTypes })');
    expect(blockCode).toContain('const scoped = viewTypeId != null;');
  });

  it('the create-time reach warning is gated on ONE TYPE IN VIEW, so the filter satisfies it', () => {
    // r224 pins this same literal from the other side (test/r224-eligibility-coverage.test.ts). Held here
    // too, next to the reason it now means more than it did: `scoped` used to be `leaveTypeId != null` and
    // could therefore only ever be true on the leave type screen.
    expect(blockCode).toContain('!editingTemplate && scoped && scopedHealth');
    expect(blockCode).toContain('newTableReachesNobody(scopedHealth)');
  });

  it('the things that are about being INSIDE a leave type tab stay on `embedded`, not on `scoped`', () => {
    // Widening `scoped` must not widen these. The `#type-<id>` fragment names a panel that exists only on
    // the leave type screen; `embeddedLeaveTypeId` sends a save back to a tab the operator was not on; and
    // the default-table picker is "Not shown" on this tab in the approved responsibility matrix, because
    // putting it on two screens is the duplication the item exists to remove.
    expect(blockCode).toContain('const embedded = leaveTypeId != null;');
    expect(blockCode).toContain('(embedded ? `${query}#type-${leaveTypeId}` : query)');
    expect(blockCode).toContain('const returnField = embedded ?');
    expect(blockCode).toContain('{embedded && scopedType ? (');
  });

  it('the standalone tab passes the filter from the URL and highlights the linked table', () => {
    expect(standaloneCode).toContain('typeFilter={sp.leaveType}');
    expect(standaloneCode).toContain('highlightTable={sp.table}');
    // No HARDCODED leave type: the decision the two anti-filter guards pin, restated from this side.
    const mount = standaloneCode.slice(standaloneCode.indexOf('<EntitlementTablesBlock'));
    expect(mount.slice(0, mount.indexOf('/>'))).not.toContain('leaveTypeId');
  });

  it('“+ New table” is a round trip: the create it opens posts the leave type to return to', () => {
    // The approved plan's step 2.4 — saving brings the operator back to the leave type screen with the new
    // table visible. `returnFor` in ./actions.ts already reads `embeddedLeaveTypeId` and `saved()` sends
    // them to that type's tab 3; until r369 only the EMBEDDED mount posted it, so a create typed on the
    // Entitlement tables tab always stayed there — right for someone who went there directly, wrong for
    // someone who pressed "+ New table".
    expect(blockCode).toContain('&returnTo=${encodeURIComponent(leaveTypeId ?? \'\')}#new-entitlement-table');
    expect(blockCode).toContain('returnToType ? <input type="hidden" name="embeddedLeaveTypeId" value={returnToType} />');
    expect(blockCode).toContain('{formReturnField}');
    // ⚠️ THE ROW CONTROLS MUST NOT GET IT. A Stop or Delete pressed on the Entitlement tables tab belongs
    // back on the Entitlement tables tab; bouncing a destructive save to another screen hides its result.
    expect(blockCode).toContain('const returnField = embedded ?');
    expect(stripComments(read(STANDALONE))).toContain('returnToType={sp.returnTo}');
  });

  it('the create form POSTS the type it is showing, so a filtered create is not a create with no type', () => {
    // On the filtered standalone tab `leaveTypeId` is undefined. Posting it would submit a create with no
    // leave type while the read-only field beside it said "Annual Leave" — a refusal the operator could not
    // explain from anything on screen.
    expect(blockCode).toContain('<input type="hidden" name="leaveTypeId" value={viewTypeId} />');
  });

  it('a deep link can be scrolled to without JavaScript: the row head carries an id keyed on the LINEAGE', () => {
    // The lineage is the table's identity through time. A link keyed on the VERSION id would land nowhere
    // the first time somebody superseded the table it names.
    expect(blockCode).toContain('id={r.firstOfTable && x ? `table-${x.lineageId}` : undefined}');
    expect(blockCode).toContain('x.lineageId === highlightTable');
  });

  it('the filter posts to the SAME address — a new route would break four exact-set nav guards', () => {
    // test/leave-config-map.test.ts pins the Entitlements row as exactly ['leaveTypes','entitlementTables'];
    // test/leave-flyout-nav.test.ts pins two items and ownedSubpaths of exactly the one path;
    // test/r266-leave-config-rows.test.ts pins the flattened href list and its count of two.
    expect(standaloneCode).toContain('method="get"');
    expect(standaloneCode).toContain('name="leaveType"');
    expect(standaloneCode).not.toContain('action="/admin');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §5 · the create move — one screen edits tables, and the other one links to it
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§5 · tablesReadOnly — GATED, never forked, and never at the cost of the filter', () => {
  const blockCode = stripComments(read(BLOCK));
  const typesCode = stripComments(read(TYPES_PAGE));

  it('the flag defaults to today’s behaviour and does not name the scope', () => {
    // Same shape and the same naming constraint as showConfigHealth / showBenefitSchemes: a flag carrying
    // the substring `leaveTypeId` would read to the two anti-filter guards as the hardcoded filter coming
    // back. Default false, so the Entitlement tables tab is untouched by it.
    expect(blockCode).toContain('tablesReadOnly = false');
    expect(blockCode).not.toContain('readOnlyLeaveTypeId');
  });

  it('the leave type tab passes it AND keeps passing leaveTypeId — read-only is a SECOND property', () => {
    // ⚠️ THE FAILURE MODE THIS FORBIDS: implementing "read-only" by dropping the filter. That would make
    // tab 3 list every leave type's tables, which is neither what the reporter asked for nor something any
    // other guard would catch — test/entitlement-tables-embed.test.ts §1 asserts the string below, so the
    // two facts are pinned together here.
    expect(typesCode).toContain('leaveTypeId={leaveTypeId}');
    expect(typesCode).toContain('tablesReadOnly');
    // The Entitlement tables tab must NOT pass it: it is the one screen that edits tables.
    expect(stripComments(read(STANDALONE))).not.toContain('tablesReadOnly');
  });

  it('every control the matrix moves is GATED, and every one of them survives in the source', () => {
    // r210 §D, r219 and r224 all read these literals out of this file. Gating keeps them; deleting them
    // would take the editor away from the Entitlement tables tab as well, and fail those guards — the same
    // conclusion reached from two directions, which is why this is a conditional and not a removal.
    for (const kept of [
      'action={retireEntitlementTemplateAction}',
      'action={deleteEntitlementTemplateAction}',
      '?editTemplate=',
      'name="validTo"',
      "t('deleteBlockedByRules'",
      '<EntitlementEffectiveFromField />',
      "<EntitlementSaveModeSubmit createLabel={t('createTemplate')} />",
      '<EntitlementBandsEditor',
    ]) {
      expect(blockCode, `${kept} must survive the gate`).toContain(kept);
    }
    // …and the gate itself, outside the row-controls slice anchor the r210 and r271 guards cut on.
    expect(blockCode).toContain('{r.firstOfTable && x ? (');
    expect(blockCode).toContain('{tablesReadOnly ? (');
    expect(blockCode).toContain('{tablesReadOnly ? null : (');
  });

  it('a read-only row offers the way to the editor instead, keyed on the lineage and the ONE address', () => {
    // Built from ENTITLEMENT_TEMPLATES rather than a typed path: that constant is already the address every
    // table save returns to, and a literal here would be a second statement about where the screen lives.
    expect(blockCode).toContain("import { ENTITLEMENT_TEMPLATES } from '@/app/admin/_redirects'");
    expect(blockCode).toContain("t('manageInTables')");
    expect(blockCode).toContain("t('newTableElsewhere')");
    // The link preselects the filter §1 is about — which is the whole reason the filter shipped first. A
    // "+ New table" link landing on an UNFILTERED tab would open a create form that cannot warn.
    // The round trip half of this href is asserted in its own case above; here only that it preselects the
    // filter, which is the whole reason the filter shipped first — a "+ New table" link landing on an
    // UNFILTERED tab would open a create form that cannot warn.
    expect(blockCode).toContain('?leaveType=${encodeURIComponent(leaveTypeId ?? \'\')}&returnTo=');
    expect(blockCode).toContain('&table=${encodeURIComponent(lineageId)}#table-${lineageId}');
    // …and the create form carries that fragment's target.
    expect(blockCode).toContain('id="new-entitlement-table"');
  });

  it('the benefit scheme controls are NOT gated with it — the matrix keeps them editable on the leave type tab', () => {
    // "Default table and benefit schemes: Editable" on the leave type screen, in the reporter's own table.
    // They are governed by showBenefitSchemes, which is already true there and false on the other tab.
    const gate = blockCode.indexOf('{showBenefitSchemes ? (');
    expect(gate).toBeGreaterThan(-1);
    const schemes = blockCode.slice(gate);
    expect(schemes).toContain('<EligibilityRuleForm');
    expect(schemes).not.toContain('tablesReadOnly');
  });

  it('the five sentences that promised editing on the leave type screen have been reworded, in six locales', () => {
    /**
     * PROSE OUTLIVES THE KERNEL. Each of these asserted the rule this round reverses — two of them on an
     * EMPLOYEE's own leave balance. Retired in place: the keys are not deleted, the values are corrected,
     * and each names the destination with the string the MENU uses for that screen in the same locale.
     */
    const STALE = [
      'leave.errors.insufficientBalanceNoTableOther',
      'leave.breakdown.statusNoEntitlementTableBody',
      'me.leaveBalanceTable.statusNoEntitlementTableTip',
      'admin.leave.entitlementStep.tablesHint',
      'admin.entitlementTemplates.rulesNeedTemplate',
    ] as const;
    const at = (cat: unknown, path: string) =>
      path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], cat);

    /**
     * ⚠️ WHY THE "DOES NOT SEND THEM TO THE LEAVE TYPES SCREEN" HALF IS ENGLISH-ONLY, AND IT IS A LIMIT OF
     * SUBSTRINGS RATHER THAN A GAP IN THE WORK.
     *
     * In several locales the MENU label for Leave types is also ordinary prose: `ms` calls that menu entry
     * "Jenis cuti", which is simply "leave type", and the very sentence under test opens "Jenis cuti ini…"
     * ("This leave type…"). A substring check cannot tell a destination from a sentence's subject, so a
     * cross-locale negative assertion here would fail on correct copy. In `th` the reverse trap exists: the
     * Entitlement tables menu label "ตารางสิทธิ" is a substring of the ordinary words for "entitlement
     * table", so a cross-locale POSITIVE assertion can pass on the old wording.
     *
     * So the destination is pinned precisely in `en` — the source catalogue, and the one the reporter reads —
     * and all six are pinned on the two properties that hold regardless of language: the key still EXISTS
     * (retired in place, never deleted) and it is translated. `scripts/i18n-check.mjs` holds parity and
     * placeholders, and test/r266-benefit-scheme-vocabulary.test.ts pins the same `en` destination from the
     * other side.
     */
    const en = catalogue('en');
    for (const key of STALE) {
      const v = at(en, key) as string;
      expect(v, `en ${key} still sends the reader to the Leave types screen`).not.toContain('Leave types screen');
    }
    for (const key of STALE.slice(0, 3)) {
      expect(at(en, key) as string, `en ${key} must name the Entitlement tables screen`).toContain(
        'on the Entitlement tables screen',
      );
    }
    // The helper line no longer promises that the days can be set BELOW it, because they cannot.
    const hint = at(en, 'admin.leave.entitlementStep.tablesHint') as string;
    expect(hint).toContain('Tables are managed in Entitlement tables');
    expect(hint, 'the old promise was "Set this leave type\'s days … below"').not.toContain("Set this leave type");

    for (const loc of LOCALES) {
      const cat = catalogue(loc);
      for (const key of STALE) {
        const v = at(cat, key);
        expect(typeof v, `${loc} ${key} must still EXIST — retire in place, never delete`).toBe('string');
        expect((v as string).length, `${loc} ${key}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(v, `${loc} ${key} is still English`).not.toBe(at(en, key));
      }
    }
  });

  it('the IA document no longer promises table editing on tab 3 — no test but this one reads it', () => {
    // The r258/r270 lesson applied in reverse: when a surface is REMOVED, the design document is half the
    // fix, and F11 is the written promise this item reverses.
    const f11 = read('/docs/design/a6fe37fc-leave-config-ia.md')
      .split('\n')
      .find((l) => l.startsWith('| F11 |'));
    expect(f11, 'the F11 row must still exist').toBeTruthy();
    expect(f11!).toContain('read-only');
    expect(f11!).toContain('r369');
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────────────────
// §4 · the control says what it does, in every locale
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§4 · the filter’s own strings', () => {
  const KEYS = [
    'filterLeaveType',
    'filterAllTypes',
    'filterApply',
    'filterHint',
    // 3a4efe9f — the caption follows the filter. The unfiltered sentence over a filtered list would
    // contradict the table under it, and the sentence's job is to say how to widen the screen again.
    'filterHintScoped',
    // The approved sketch's top-right way in to the create form, which has NOT moved.
    'newTableJump',
  ] as const;

  it('all four strings exist in all six catalogues and are translated', () => {
    const en = catalogue('en').admin.entitlementTemplates as Record<string, string>;
    for (const k of KEYS) {
      expect(typeof en[k], `en ${k}`).toBe('string');
      expect(en[k].length, `en ${k}`).toBeGreaterThan(0);
      for (const loc of LOCALES) {
        const v = (catalogue(loc).admin.entitlementTemplates as Record<string, string>)[k];
        expect(typeof v, `${loc} ${k}`).toBe('string');
        expect(v.length, `${loc} ${k}`).toBeGreaterThan(0);
        if (loc !== 'en') expect(v, `${loc} ${k} is still English`).not.toBe(en[k]);
      }
    }
  });

  it('the screen asks for every one of them, so none is an orphan key', () => {
    const standaloneCode = stripComments(read(STANDALONE));
    for (const k of KEYS) {
      // `filterHintScoped` takes an argument, so it is asked for as `t('key', {...})`.
      expect(standaloneCode, k).toContain(`t('${k}'`);
    }
    // …and the two captions are the two ARMS of one choice, not one sentence plus a dead key.
    expect(standaloneCode).toContain("filteredTypeName ? t('filterHintScoped', { type: filteredTypeName }) : t('filterHint')");
    // The scoped caption names the type, so it must carry the placeholder in every locale.
    for (const loc of LOCALES) {
      const v = (catalogue(loc).admin.entitlementTemplates as Record<string, string>).filterHintScoped;
      expect(v, `${loc} filterHintScoped`).toContain('{type}');
    }
  });

  it('the top-right button is a jump to the ONE create form, not a second form', () => {
    // The approved sketch shows "+ New entitlement table" opposite the filter. The form itself stays at the
    // foot of the list where eight guards read it; a second form here would be the fork this item removes.
    const standaloneCode = stripComments(read(STANDALONE));
    expect(standaloneCode).toContain('href="#new-entitlement-table"');
    expect(standaloneCode).not.toContain('createEntitlementTemplateAction');
  });
});
