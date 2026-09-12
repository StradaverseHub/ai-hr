/**
 * r224 — THE ELIGIBILITY COVERAGE GAP, MADE VISIBLE BEFORE IT IS FOUND BY ACCIDENT.
 *
 * MEASURED ON PRODUCTION 2026-08-26 — entitlement tables in force versus eligibility rules in force:
 * Annual Leave 16/0 · Graduation 3/0 · Marriage 3/0 · Caregiver 3/0 · Paternity 3/0 · Study 3/0 ·
 * Maternity 3/0 · Compassionate 3/0 · Hospitalization 1/0 · Medical 6/1 · Examination 3/1. Nine of eleven
 * leave types resolve to nothing at all, and the only screen that said so was the health panel INSIDE one
 * leave type's Entitlement step — reachable one leave type at a time, on the right step.
 *
 * ⚠️ ONE CORRECTION TO THE APPROVED ITEM, PINNED HERE BECAUSE THE COPY DEPENDS ON IT.
 * The item says employees are quietly receiving the STATUTORY MINIMUM instead of the configured figure.
 * That was true of the composition this codebase used to have (`max(statutoryFloor, configured)`), and it
 * is not true of the one it has now: feedback fa3f4ccb made the Employment Act floor ADVISORY —
 * `composeEntitlement` (core/leave-compute.ts) carries `belowStatutoryFloor` as a SIGNAL and the floor
 * "no longer participates in the arithmetic anywhere". With no eligibility rule in force no band resolves,
 * `noOpinion` is set, and `openLeaveYear` records the pair as `no_entitlement` and writes NO accrual row.
 * So the honest "actually granted" figure today is 0.00, not the statutory minimum, and the screen says
 * that. The production ledger figures quoted in the item were granted under the older composition. §C
 * pins the wording so a future edit cannot quietly restore the claim without restoring the arithmetic.
 *
 * WHAT IS PINNED:
 *   §A the two predicates — "these tables reach nobody" and "would a table created here reach anybody",
 *      which are NOT the same question, and the difference is the sole-table fallback (r193 fault 3).
 *   §B the configured range, the "what your table says" half of configured-versus-actual.
 *   §C the contract between the derivation and the three screens that now read it (AGENTS rule 17: a
 *      defect that lives between two files is invisible to a unit test of either half).
 *
 * PURE — no database, no fixtures beyond plain objects. `lib/leave-config-health.ts` imports nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  leaveTypeConfigHealth,
  newTableReachesNobody,
  tablesReachNobody,
  type HealthLeaveType,
  type HealthRule,
  type HealthTemplate,
} from '../lib/leave-config-health';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

const TODAY = '2026-08-26';

const type = (over: Partial<HealthLeaveType> = {}): HealthLeaveType => ({
  id: 'lt-annual',
  name: 'Annual Leave',
  accrualMethod: 'grant_on_hire_prorated',
  accrualUnconfigured: false,
  defaultEntitlementTemplateLineageId: null,
  archived: false,
  ...over,
});

const template = (over: Partial<HealthTemplate> = {}): HealthTemplate => ({
  lineageId: 'tpl-1',
  leaveTypeId: 'lt-annual',
  name: 'Annual — Grade 12',
  validFrom: '2026-01-01',
  validTo: null,
  serviceBands: [{ days: 12 }],
  ...over,
});

const rule = (over: Partial<HealthRule> = {}): HealthRule => ({
  lineageId: 'rule-1',
  name: 'PERMANENT',
  templateLineageId: 'tpl-1',
  validFrom: '2026-01-01',
  validTo: null,
  criteria: {},
  ...over,
});

const health = (templates: HealthTemplate[], rules: HealthRule[]) =>
  leaveTypeConfigHealth({ leaveType: type(), templates, rules, grades: [], today: TODAY });

// ── §A the two predicates ────────────────────────────────────────────────────────────────────────────

describe('§A r224 · "reaches nobody" and "a new table would reach nobody" are different questions', () => {
  it('the reporter\'s Annual Leave — sixteen tables, no rule — reaches nobody', () => {
    const templates = Array.from({ length: 16 }, (_, i) =>
      template({ lineageId: `tpl-${i}`, name: `Annual ${i}`, serviceBands: [{ days: 12 + i }] }),
    );
    const h = health(templates, []);
    expect(tablesReachNobody(h)).toBe(true);
    expect(h.noRuleInForce).toBe(true);
    // …and it is the r209 finding, not a second expression over the same counts.
    expect(h.findings).toContain('no_rule_in_force');
  });

  it('Hospitalization — ONE table, no rule — reaches EVERYBODY and is not flagged', () => {
    // r193 fault 3: nothing to choose between, so the sole table applies to all. Flagging this shape is
    // how a warning stops being read, and it is the commonest healthy configuration in the product.
    const h = health([template()], []);
    expect(h.soleTableApplies).toBe(true);
    expect(tablesReachNobody(h)).toBe(false);
  });

  it('…but a SECOND table on that leave type ends the fallback, so the create form warns', () => {
    const h = health([template()], []);
    // Nothing is wrong TODAY, and creating another table is what makes it wrong — which is exactly why
    // this predicate is not `tablesReachNobody`.
    expect(tablesReachNobody(h)).toBe(false);
    expect(newTableReachesNobody(h)).toBe(true);
  });

  it('the FIRST table on an empty leave type is not warned about — it becomes the sole table', () => {
    const h = health([], []);
    expect(newTableReachesNobody(h)).toBe(false);
  });

  it('a rule in force stops the create warning; a rule pointing at a STOPPED table does not', () => {
    expect(newTableReachesNobody(health([template()], [rule()]))).toBe(false);
    // The engine's own gate joins through EVERY version of the lineage, in force or not: a rule pointing
    // at a stopped table still blocks the sole-table fallback, so the type grants nothing and a new table
    // changes nothing about that. `ruleCount` drops such a rule; `noRuleInForce` must not.
    const stopped = template({ validTo: '2026-06-01' });
    const h = health([stopped, template({ lineageId: 'tpl-2', name: 'Annual B' })], [rule()]);
    expect(h.ruleCount).toBe(0); // it can hand nobody a table…
    expect(h.noRuleInForce).toBe(false); // …but HR has stated an opinion, so no sole-table fallback
    expect(newTableReachesNobody(h)).toBe(false);
  });

  it('an EXPIRED rule leaves the tables reaching nobody — the r209 production state', () => {
    const h = health([template(), template({ lineageId: 'tpl-2', name: 'Annual B' })], [
      rule({ validTo: '2026-08-13' }),
    ]);
    expect(tablesReachNobody(h)).toBe(true);
  });
});

// ── §B the configured half of configured-versus-actual ───────────────────────────────────────────────

describe('§B r224 · what the tables actually specify, so it can be put beside what is granted', () => {
  it('spans every band of every table IN FORCE, lowest to highest', () => {
    const h = health(
      [
        template({ serviceBands: [{ days: 12 }, { days: 16 }] }),
        template({ lineageId: 'tpl-2', name: 'Annual B', serviceBands: [{ days: 24 }] }),
      ],
      [],
    );
    expect(h.configuredDaysMin).toBe(12);
    expect(h.configuredDaysMax).toBe(24);
  });

  it('a SUPERSEDED version is not counted — it is not what anybody would be granted today', () => {
    const h = health(
      [
        template({ validFrom: '2025-01-01', validTo: '2026-01-01', serviceBands: [{ days: 60 }] }),
        template(),
      ],
      [],
    );
    expect(h.configuredDaysMax).toBe(12);
  });

  it('no table in force ⇒ no range, and the screen shows no comparison', () => {
    const h = health([], []);
    expect(h.configuredDaysMin).toBeNull();
    expect(h.configuredDaysMax).toBeNull();
  });
});

// ── §C the contract with the screens ─────────────────────────────────────────────────────────────────

describe('§C r224 · the three surfaces read the derivation rather than recomputing it', () => {
  const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

  it('the leave configuration landing screen flags each leave type in its own list', () => {
    const page = read('app/admin/leave-config/types/page.tsx');
    // Read from the SAME `configHealth` the card below the list already renders — a badge computed from a
    // second expression is how a list comes to flag a type the card calls healthy.
    expect(page).toContain('tablesReachNobody');
    expect(page).toContain("alert: configHealth.some(");
    expect(page).toContain("t('workspaceReachesNobody')");
    const workspace = read('components/leave-type-workspace.tsx');
    // The flag reaches BOTH renderings of the list, and the mobile one is the easy half to forget: it is a
    // native <select>, so the alert has to ride in the option TEXT or the phone shows an unflagged list.
    expect(workspace).toContain('title={item.alert}');
    expect(workspace).toMatch(/<option[\s\S]{0,240}item\.alert/);
  });

  it('configured-versus-actual is rendered on both health mounts, and never claims a statutory credit', () => {
    const card = read('components/leave/leave-config-health.tsx');
    expect(card.match(/<ConfiguredVsActual /g) ?? []).toHaveLength(2);
    expect(card).toContain('tablesReachNobody(h)');
    for (const loc of LOCALES) {
      const ns = (JSON.parse(read(`messages/${loc}.json`)) as Record<string, any>).admin
        .entitlementTemplates as Record<string, string>;
      expect(typeof ns.healthConfiguredVsActual, `${loc}`).toBe('string');
      expect(ns.healthConfiguredVsActual).toContain('{configured}');
      expect(ns.healthConfiguredVsActual).toContain('{tables}');
    }
    // ⚠️ THE CLAIM THE ITEM ASKED FOR AND THE CODE NO LONGER SUPPORTS. fa3f4ccb made the statutory floor
    // advisory, so nothing falls back to it; a sentence saying employees receive the legal minimum would
    // describe an arithmetic this repository removed. If the floor is ever restored to the composition,
    // change the copy AND this case together.
    const en = (JSON.parse(read('messages/en.json')) as Record<string, any>).admin
      .entitlementTemplates as Record<string, string>;
    expect(en.healthConfiguredVsActual).not.toMatch(/statutory|minimum/i);
    // ⚠️ AND IT MUST NOT PRINT A FIGURE EITHER — this half REPLACES an assertion that required the
    // literal "0.00" in the copy. Both halves of that original case were about honesty and only one
    // survived contact with AGENTS rule 28: the string is a static translation, so a "0.00" in it is
    // not a measurement of anything, and it rendered beside employees whose records visibly show ~11.4
    // accrued days (granted under the pre-fa3f4ccb composition). An absent figure asserts nothing; a
    // 0.00 asserts the days do not exist. The copy states the CONDITION instead, so this pins that no
    // digits are quoted outside the two interpolations the screen actually supplies.
    expect(en.healthConfiguredVsActual.replace(/\{configured\}|\{tables\}/g, '')).not.toMatch(/\d/);
    expect(read('core/leave-compute.ts')).toContain('ADVISORY since fa3f4ccb — flagged, never applied');
  });

  it('the create form warns at the moment a table is typed, with the two different answers', () => {
    const block = read('app/admin/leave/entitlements/templates/entitlement-tables-block.tsx');
    expect(block).toContain('newTableReachesNobody(scopedHealth)');
    expect(block).toContain("t('createEndsSoleTableWarning'");
    expect(block).toContain("t('createNoRuleWarning'");
    // On the CREATE form only: an edit is not the moment to say a table reaches nobody.
    expect(block).toContain('!editingTemplate && scoped && scopedHealth');
    for (const loc of LOCALES) {
      const ns = (JSON.parse(read(`messages/${loc}.json`)) as Record<string, any>).admin
        .entitlementTemplates as Record<string, string>;
      for (const k of ['createNoRuleWarning', 'createEndsSoleTableWarning'] as const) {
        expect(typeof ns[k], `${loc} ${k}`).toBe('string');
        expect(ns[k], `${loc} ${k}`).toContain('{type}');
      }
    }
  });

  it('nothing in this stream creates an eligibility rule — the plan promised it would not', () => {
    // Which employees should receive which table is a policy decision, and guessing a criteria object
    // would silently widen or narrow who a table reaches. Every surface added here is read-only.
    const page = read('app/admin/leave-config/types/page.tsx');
    const card = read('components/leave/leave-config-health.tsx');
    for (const src of [page, card]) {
      expect(src).not.toContain('createEligibilityRule(');
    }
  });
});
