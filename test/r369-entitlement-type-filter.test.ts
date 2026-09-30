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
import type { HealthLeaveType, HealthRule, HealthTemplate } from '../lib/leave-config-health';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const BLOCK = '/app/admin/leave/entitlements/templates/entitlement-tables-block.tsx';
const STANDALONE = '/app/admin/leave-config/entitlement-tables/page.tsx';
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
  const today = '2026-06-01';
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
    // Derived from the case's own clock, never a hardcoded year: a fixture dated in the past relative to a
    // future test run would silently stop being "in force" and take the assertion with it.
    validFrom: '2020-01-01',
    validTo: null,
    serviceBands: [{ days: 14 }],
  });
  const rule = (templateLineageId: string): HealthRule => ({
    lineageId: `rule-for-${templateLineageId}`,
    name: 'Everyone',
    templateLineageId,
    validFrom: '2020-01-01',
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
// §4 · the control says what it does, in every locale
// ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('§4 · the filter’s own strings', () => {
  const KEYS = ['filterLeaveType', 'filterAllTypes', 'filterApply', 'filterHint'] as const;

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
    for (const k of KEYS) expect(standaloneCode, k).toContain(`t('${k}')`);
  });
});
