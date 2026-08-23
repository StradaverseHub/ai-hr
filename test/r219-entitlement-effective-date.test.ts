/**
 * r219 ca7766ab — "Leave Entitlement Table – Allow Override of Effective Date".
 *
 * THE DEFECT, in one line: both writers in core/entitlement-template.ts refused with
 * `open.validFrom >= p.validFrom`, which compares the RUNNING VERSION AGAINST ITSELF. Saving the version
 * you were editing with its own date was refused, and the refusal told the operator to "edit that version
 * instead" — of a version they had no way to reach, because `updateEntitlementTemplate` /
 * `updateEligibilityRule` are the only edit entry points there are and both always superseded. The
 * consequence the reporter hit: you could not correct a table on the day you created it, and you could not
 * pull a mis-keyed date back.
 *
 * WHAT IS PINNED HERE, and why each case earns its place:
 *
 *  §A THE FOUR ARMS OF THE DECISION, as a pure function. `entitlementEditMode` is the whole of the rule
 *    and both writers read it, so the arms are stated once where no database can obscure which one fired.
 *
 *  §B TEMPLATES, against a real database, because "updates in place" is a claim about ROW COUNTS that
 *    cannot be seen from the return value: a supersede and an in-place edit both hand back a running row
 *    carrying the new figures. Only counting the lineage's versions afterwards tells them apart.
 *
 *  §C THE ONE THAT MUST NOT REGRESS. A version that HAS been in force still supersedes, exactly as before.
 *    Changing the start date of a table that was in force would quietly change what a CLOSED leave year
 *    says an employee was entitled to — three readers resolve entitlement at a past date — and that is the
 *    single thing the versioning exists to prevent. Asserted with a past-date read, not only a row count.
 *
 *  §D THE OVERLAP. An in-place UPDATE creates no second running row, so it trips neither partial-unique
 *    index (one running version per lineage; one running NAME per leave type). What it CAN do is move the
 *    running version's start into a window a SUPERSEDED sibling already claims, which nothing in the
 *    database refuses. The refusal names the sibling's own window, and the lineage stays CONTIGUOUS when a
 *    legal move is made — a gap would be a stretch with no version of the table in force at all, which
 *    close-then-insert has never produced.
 *
 *  §E THE SAME FOUR FOR ELIGIBILITY RULES. The restriction existed there for the same reason and in the
 *    same self-referential form; correcting one and leaving the other is what the plan promised not to do.
 *
 *  §F THE SCREEN'S WORDS, in all six locales. "Saving closes the running version and starts a new one" is
 *    now true of only one of the two saves, so the form picks its caption from the same question the
 *    service asks.
 *
 * ⚠️ `today` IS PASSED EXPLICITLY IN EVERY CASE BELOW. The rule is a comparison against the calendar day,
 * so a fixture dated relative to nothing would change its meaning as the wall clock moved past it — the
 * "still supersedes" case would quietly become an in-place case and keep passing while asserting nothing.
 * The app never passes it; no form posts it.
 *
 * ⚠️ AND THE TEST IS A DATE TEST, NOT A USAGE TEST. `leave_ledger` records no reference to the entitlement
 * table or eligibility rule that produced a row, so nothing here proves — or should be read as proving —
 * that nothing was ever calculated from a version this file calls "not started yet".
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema';
import {
  createEligibilityRule,
  createEntitlementTemplate,
  entitlementEditMode,
  listEntitlementTemplates,
  updateEligibilityRule,
  updateEntitlementTemplate,
} from '../core/entitlement-template';
import type { ServiceBand } from '../core/leave-compute';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

/** The clock every case below is written against. Every date in this file is read relative to it. */
const TODAY = '2026-06-30';

const flat = (days: number): ServiceBand[] => [{ fromYears: 0, toYears: null, days }];
const uniq = (p: string) => `${p} ${randomUUID().slice(0, 8)}`;

/** Every version of one template lineage, oldest start first — read as the OWNER, outside RLS. */
const versionsOf = (lineageId: string) =>
  owner.db
    .select({
      id: schema.entitlementTemplate.id,
      name: schema.entitlementTemplate.name,
      serviceBands: schema.entitlementTemplate.serviceBands,
      validFrom: schema.entitlementTemplate.validFrom,
      validTo: schema.entitlementTemplate.validTo,
    })
    .from(schema.entitlementTemplate)
    .where(eq(schema.entitlementTemplate.lineageId, lineageId))
    .then((rows) => [...rows].sort((x, y) => x.validFrom.localeCompare(y.validFrom)));

const ruleVersionsOf = (lineageId: string) =>
  owner.db
    .select({
      id: schema.entitlementEligibilityRule.id,
      name: schema.entitlementEligibilityRule.name,
      criteria: schema.entitlementEligibilityRule.criteria,
      validFrom: schema.entitlementEligibilityRule.validFrom,
      validTo: schema.entitlementEligibilityRule.validTo,
    })
    .from(schema.entitlementEligibilityRule)
    .where(eq(schema.entitlementEligibilityRule.lineageId, lineageId))
    .then((rows) => [...rows].sort((x, y) => x.validFrom.localeCompare(y.validFrom)));

const eventTypesFor = (aggregateId: string) =>
  owner.db
    .select({ eventType: schema.domainEvent.eventType })
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.aggregateId, aggregateId))
    .then((rows) => rows.map((r) => r.eventType));

const makeTemplate = (validFrom: string, days = 14, name = uniq('Executive')) =>
  createEntitlementTemplate(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    name,
    serviceBands: flat(days),
    validFrom,
  });

// ── §A the decision itself ───────────────────────────────────────────────────────────────────────────

describe('§A r219 · which write an edit is — the four arms, stated once', () => {
  it('a version that has NOT started yet is edited in place, whichever way the date moves', () => {
    const openValidFrom = '2026-12-01'; // after TODAY
    expect(entitlementEditMode({ openValidFrom, newValidFrom: '2026-09-01', today: TODAY })).toBe('in-place');
    expect(entitlementEditMode({ openValidFrom, newValidFrom: '2027-03-01', today: TODAY })).toBe('in-place');
    // …including a date in the past, which is a correction of a version that never took effect.
    expect(entitlementEditMode({ openValidFrom, newValidFrom: '2026-01-01', today: TODAY })).toBe('in-place');
  });

  it('the same date is an in-place save — it is the same version, and this is the defect', () => {
    // THE COMPARE-AGAINST-ITSELF CASE. `open.validFrom >= p.validFrom` refused this, which is why saving
    // a table on the day you created it was impossible.
    expect(entitlementEditMode({ openValidFrom: '2026-01-01', newValidFrom: '2026-01-01', today: TODAY })).toBe(
      'in-place',
    );
    expect(entitlementEditMode({ openValidFrom: TODAY, newValidFrom: TODAY, today: TODAY })).toBe('in-place');
  });

  it('a version in force plus a LATER date is still a supersede, and an EARLIER date is refused', () => {
    expect(entitlementEditMode({ openValidFrom: '2026-01-01', newValidFrom: '2026-07-01', today: TODAY })).toBe(
      'supersede',
    );
    // The boundary: a version starting TODAY has been in force (for today), so it supersedes rather than
    // being edited in place.
    expect(entitlementEditMode({ openValidFrom: TODAY, newValidFrom: '2026-07-01', today: TODAY })).toBe('supersede');
    expect(entitlementEditMode({ openValidFrom: '2026-01-01', newValidFrom: '2025-12-31', today: TODAY })).toBe(
      'refuse',
    );
  });
});

// ── §B / §C / §D templates ───────────────────────────────────────────────────────────────────────────

describe('§B r219 · a template version that has not started is EDITED, not superseded', () => {
  it('a future-dated version pulled back to an EARLIER date updates in place — and creates NO second row', async () => {
    const v1 = await makeTemplate('2026-12-01', 14);
    const edited = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v1.lineageId,
      serviceBands: flat(18),
      validFrom: '2026-09-01', // earlier than the version's own date, which used to be refused outright
      today: TODAY,
    });

    expect(edited.id).toBe(v1.id); // the SAME row, not a successor
    const rows = await versionsOf(v1.lineageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].validFrom).toBe('2026-09-01');
    expect(rows[0].validTo).toBeNull();
    expect(rows[0].serviceBands).toEqual(flat(18));
    // The audit says which write happened; a supersede event here would mean a second version exists.
    expect(await eventTypesFor(v1.id)).toEqual([
      'entitlement-template.created',
      'entitlement-template.updated',
    ]);
  });

  it('the running version saved with its OWN date updates in place — the reporter\'s dead end', async () => {
    const v1 = await makeTemplate('2026-01-01', 14);
    const edited = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v1.lineageId,
      serviceBands: flat(18),
      validFrom: '2026-01-01', // the date it already holds
      today: TODAY,
    });

    expect(edited.id).toBe(v1.id);
    const rows = await versionsOf(v1.lineageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].validFrom).toBe('2026-01-01');
    expect(rows[0].validTo).toBeNull();
    expect(rows[0].serviceBands).toEqual(flat(18));
  });

  it('a rename with no date move keeps the one row too', async () => {
    const v1 = await makeTemplate('2026-12-01', 14, 'Grade H PERMANENT r219');
    const edited = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v1.lineageId,
      name: 'Grade H PERMANENT r219 (renamed)',
      validFrom: '2026-12-01',
      today: TODAY,
    });
    expect(edited.name).toBe('Grade H PERMANENT r219 (renamed)');
    const rows = await versionsOf(v1.lineageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].serviceBands).toEqual(flat(14)); // bands omitted ⇒ preserved, as on the supersede path
  });
});

describe('§C r219 · a template that HAS been in force still supersedes — the half that must not regress', () => {
  it('a version in force given a FUTURE date closes and inserts, and the past keeps its own figures', async () => {
    const v1 = await makeTemplate('2026-01-01', 14);
    const v2 = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v1.lineageId,
      serviceBands: flat(18),
      validFrom: '2027-01-01',
      today: TODAY,
    });

    expect(v2.id).not.toBe(v1.id);
    const rows = await versionsOf(v1.lineageId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: v1.id, validFrom: '2026-01-01', validTo: '2027-01-01' });
    expect(rows[1]).toMatchObject({ id: v2.id, validFrom: '2027-01-01', validTo: null });

    // The point of the supersede, asserted as a past-date READ rather than as a row shape: 2026 answers
    // with 14 days, which is what a closed leave year would report.
    const at2026 = await listEntitlementTemplates(adminCtx(b), { asOf: '2026-06-30' });
    expect(at2026.find((r) => r.lineageId === v1.lineageId)!.serviceBands).toEqual(flat(14));
    const at2027 = await listEntitlementTemplates(adminCtx(b), { asOf: '2027-06-30' });
    expect(at2027.find((r) => r.lineageId === v1.lineageId)!.serviceBands).toEqual(flat(18));
  });

  it('a version in force given an EARLIER date is refused, and the refusal names its own start date', async () => {
    const v1 = await makeTemplate('2026-01-01', 14);
    await expect(
      updateEntitlementTemplate(adminCtx(b), {
        lineageId: v1.lineageId,
        serviceBands: flat(18),
        validFrom: '2025-06-01',
        today: TODAY,
      }),
    ).rejects.toThrow(/in force since 2026-01-01/i);
    // …and nothing was written on the way to the refusal.
    expect(await versionsOf(v1.lineageId)).toHaveLength(1);
  });
});

describe('§D r219 · an in-place date change is checked against the lineage\'s other versions', () => {
  /** v1 in force from 2026-01-01, superseded from 2027-01-01 by a head that has not started yet. */
  const supersededThenFuture = async () => {
    const v1 = await makeTemplate('2026-01-01', 14);
    const v2 = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v1.lineageId,
      serviceBands: flat(18),
      validFrom: '2027-01-01',
      today: TODAY,
    });
    return { v1, v2 };
  };

  it('a date that would overlap a SUPERSEDED sibling is refused, and the message names that version', async () => {
    const { v1, v2 } = await supersededThenFuture();
    await expect(
      updateEntitlementTemplate(adminCtx(b), {
        lineageId: v2.lineageId,
        serviceBands: flat(20),
        validFrom: '2026-06-01', // inside v1's window
        today: TODAY,
      }),
    ).rejects.toThrow(/runs from 2026-01-01 until 2027-01-01/);
    // Named by its own dates, and nothing moved.
    const rows = await versionsOf(v1.lineageId);
    expect(rows.map((r) => [r.validFrom, r.validTo])).toEqual([
      ['2026-01-01', '2027-01-01'],
      ['2027-01-01', null],
    ]);
  });

  it('a legal forward move keeps the lineage CONTIGUOUS — the predecessor ends where the head now starts', async () => {
    const { v1, v2 } = await supersededThenFuture();
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v2.lineageId,
      serviceBands: flat(20),
      validFrom: '2027-06-01',
      today: TODAY,
    });
    const rows = await versionsOf(v1.lineageId);
    expect(rows).toHaveLength(2); // still two — the head was edited, not superseded again
    // No hole: without retying v1's end there would be nothing in force from 2027-01-01 to 2027-06-01.
    expect(rows.map((r) => [r.validFrom, r.validTo])).toEqual([
      ['2026-01-01', '2027-06-01'],
      ['2027-06-01', null],
    ]);
    expect(rows[1].serviceBands).toEqual(flat(20));
  });

  /**
   * r219 FIX PASS — THE MIS-KEY MUST BE REVERSIBLE, WHICH IS THE WHOLE POINT OF THE ITEM.
   *
   * The forward move above retied v1's end to the head's new start. Before this pass, that made the move
   * ONE-WAY: pulling the head back again overlapped the predecessor it had just extended, and the operator
   * who typed 2027 for 2026 could never get back. The reporter's own words were "correct or backdate an
   * entitlement table when the original effective date was entered incorrectly".
   *
   * The exception is exactly one sibling wide — the lineage's own CONTIGUOUS predecessor — and only while
   * BOTH its boundary and the new date are still in the future. Nothing that has been resolved moves,
   * because nothing has been resolved against a window that has not happened yet.
   */
  it('a mis-keyed forward move can be pulled BACK, reclaiming the boundary it extended', async () => {
    const { v1, v2 } = await supersededThenFuture();
    await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v2.lineageId,
      serviceBands: flat(20),
      validFrom: '2027-06-01', // the mis-key
      today: TODAY,
    });
    const corrected = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v2.lineageId,
      serviceBands: flat(20),
      validFrom: '2027-01-01', // …and back to what was meant
      today: TODAY,
    });
    expect(corrected.validFrom).toBe('2027-01-01');
    const rows = await versionsOf(v1.lineageId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.validFrom, r.validTo])).toEqual([
      ['2026-01-01', '2027-01-01'],
      ['2027-01-01', null],
    ]);
  });

  it('but NOT back past a predecessor whose window has already elapsed — that is a closed year', async () => {
    // v1 in force from 2026-01-01, superseded from 2026-08-01 — a boundary in the PAST relative to TODAY.
    const v1 = await makeTemplate('2026-01-01', 14);
    const v2 = await updateEntitlementTemplate(adminCtx(b), {
      lineageId: v1.lineageId,
      serviceBands: flat(18),
      validFrom: '2026-08-01',
      today: '2026-07-01',
    });
    await expect(
      updateEntitlementTemplate(adminCtx(b), {
        lineageId: v2.lineageId,
        serviceBands: flat(20),
        validFrom: '2026-05-01',
        today: '2026-07-15',
      }),
    ).rejects.toThrow(/runs from 2026-01-01 until 2026-08-01/);
    const rows = await versionsOf(v1.lineageId);
    expect(rows.map((r) => [r.validFrom, r.validTo])).toEqual([
      ['2026-01-01', '2026-08-01'],
      ['2026-08-01', null],
    ]);
  });
});

// ── §E eligibility rules — the same four ─────────────────────────────────────────────────────────────

describe('§E r219 · eligibility rules carry the identical rule, for the identical reason', () => {
  const makeRule = async (validFrom: string, criteria: Record<string, unknown> = { employmentTypes: ['contract'] }) => {
    const tpl = await makeTemplate('2026-01-01', 14);
    const rule = await createEligibilityRule(adminCtx(b), {
      name: uniq('Contract staff'),
      templateLineageId: tpl.lineageId,
      criteria,
      validFrom,
    });
    return rule;
  };

  it('a future-dated rule pulled back to an EARLIER date updates in place — no second row', async () => {
    const r1 = await makeRule('2026-12-01');
    const edited = await updateEligibilityRule(adminCtx(b), {
      lineageId: r1.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      validFrom: '2026-09-01',
      today: TODAY,
    });
    expect(edited.id).toBe(r1.id);
    const rows = await ruleVersionsOf(r1.lineageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].validFrom).toBe('2026-09-01');
    expect(rows[0].validTo).toBeNull();
    expect(rows[0].criteria).toEqual({ employmentTypes: ['full_time'] });
    expect(await eventTypesFor(r1.id)).toEqual([
      'entitlement-eligibility.created',
      'entitlement-eligibility.updated',
    ]);
  });

  it('a running rule saved with its own date updates in place', async () => {
    const r1 = await makeRule('2026-01-01');
    const edited = await updateEligibilityRule(adminCtx(b), {
      lineageId: r1.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      validFrom: '2026-01-01',
      today: TODAY,
    });
    expect(edited.id).toBe(r1.id);
    const rows = await ruleVersionsOf(r1.lineageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].criteria).toEqual({ employmentTypes: ['full_time'] });
  });

  it('a rule in force given a FUTURE date still supersedes — the version in force keeps its criteria', async () => {
    const r1 = await makeRule('2026-01-01');
    const r2 = await updateEligibilityRule(adminCtx(b), {
      lineageId: r1.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      validFrom: '2026-12-01',
      today: TODAY,
    });
    expect(r2.id).not.toBe(r1.id);
    const rows = await ruleVersionsOf(r1.lineageId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: r1.id, validFrom: '2026-01-01', validTo: '2026-12-01' });
    expect(rows[0].criteria).toEqual({ employmentTypes: ['contract'] }); // the closed version is untouched
    expect(rows[1]).toMatchObject({ id: r2.id, validFrom: '2026-12-01', validTo: null });
  });

  it('a rule in force given an EARLIER date is refused, naming its own start date', async () => {
    const r1 = await makeRule('2026-01-01');
    await expect(
      updateEligibilityRule(adminCtx(b), {
        lineageId: r1.lineageId,
        criteria: {},
        validFrom: '2025-06-01',
        today: TODAY,
      }),
    ).rejects.toThrow(/in force since 2026-01-01/i);
    expect(await ruleVersionsOf(r1.lineageId)).toHaveLength(1);
  });

  it('an overlap with a superseded sibling is refused and the message names it', async () => {
    const r1 = await makeRule('2026-01-01');
    const r2 = await updateEligibilityRule(adminCtx(b), {
      lineageId: r1.lineageId,
      criteria: { employmentTypes: ['full_time'] },
      validFrom: '2026-12-01',
      today: TODAY,
    });
    await expect(
      updateEligibilityRule(adminCtx(b), {
        lineageId: r2.lineageId,
        criteria: {},
        validFrom: '2026-06-01',
        today: TODAY,
      }),
    ).rejects.toThrow(/runs from 2026-01-01 until 2026-12-01/);
  });
});

// ── §F the screen's words ────────────────────────────────────────────────────────────────────────────

describe('§F r219 · the form says which of the two saves it is about to make', () => {
  const block = readFileSync(
    resolve(ROOT, 'app/admin/leave/entitlements/templates/entitlement-tables-block.tsx'),
    'utf8',
  );

  it('the note and the button are chosen from the same question the service asks', () => {
    // The derivation exists, and BOTH captions hang off it. A form that always promised a supersede would
    // be telling the operator their save closes a version and starts a new one, on the half of the screen
    // where it does neither.
    expect(block).toContain('const templateNotStarted =');
    expect(block).toContain('const ruleNotStarted =');
    expect(block).toContain("templateNotStarted ? t('editInPlaceNote') : t('supersedeNote')");
  });

  /**
   * r219 FIX PASS — THE TWO SENTENCES HAVE TO BE TRUE OF THE WRITE THEY SIT ON, and both shipped false.
   *
   * `editInPlaceNote` said "Nothing has been worked out from it, so no past figure moves" — on a form
   * that accepts a PAST effective date, which is precisely a past figure moving. `supersedeNote` said
   * "Nothing is overwritten" — on a version that IS overwritten the moment the operator saves without
   * changing the date, which is this item's own headline behaviour. A caption is an assurance; an
   * assurance that is false on the button it labels is worse than no caption at all (AGENTS 28).
   */
  it('neither caption promises something the save it labels can break', () => {
    for (const loc of LOCALES) {
      const ns = (JSON.parse(readFileSync(resolve(ROOT, `messages/${loc}.json`), 'utf8')) as Record<string, any>).admin.entitlementTemplates as Record<string, string>;
      expect(ns.editInPlaceNote, `${loc} editInPlaceNote`).not.toMatch(/no past figure moves|nothing has been worked out/i);
      expect(ns.supersedeNote, `${loc} supersedeNote`).not.toMatch(/nothing is overwritten|no past figure moves/i);
    }
    // English carries the two conditions in words, so the operator knows which save this is.
    const en = (JSON.parse(readFileSync(resolve(ROOT, 'messages/en.json'), 'utf8')) as Record<string, any>).admin.entitlementTemplates as Record<string, string>;
    expect(en.editInPlaceNote).toMatch(/date in the past/i);
    expect(en.supersedeNote).toMatch(/without changing the date/i);
    expect(block).toContain("t('saveThisVersion')");
    // …and the date box defaults to the version's OWN date while that version has not started, instead of
    // to today, which on a future-dated version would have moved its start date on a plain Save.
    expect(block).toContain('templateNotStarted ? editingTemplate!.validFrom : today');
    expect(block).toContain('validFrom: ruleNotStarted ? editingRule.validFrom : today');
  });

  it('both new captions exist in all six locales, and none is left as the English string', () => {
    for (const loc of LOCALES) {
      const msgs = JSON.parse(readFileSync(resolve(ROOT, `messages/${loc}.json`), 'utf8')) as Record<string, any>;
      const ns = msgs.admin.entitlementTemplates as Record<string, string>;
      expect(typeof ns.editInPlaceNote, `${loc} editInPlaceNote`).toBe('string');
      expect(typeof ns.saveThisVersion, `${loc} saveThisVersion`).toBe('string');
      expect(ns.editInPlaceNote.length, `${loc} editInPlaceNote`).toBeGreaterThan(0);
      if (loc !== 'en') {
        const en = JSON.parse(readFileSync(resolve(ROOT, 'messages/en.json'), 'utf8')).admin.entitlementTemplates;
        expect(ns.editInPlaceNote, `${loc} editInPlaceNote is untranslated`).not.toBe(en.editInPlaceNote);
        expect(ns.saveThisVersion, `${loc} saveThisVersion is untranslated`).not.toBe(en.saveThisVersion);
      }
    }
  });

  it('the standing note no longer claims every edit closes the old version', () => {
    const en = JSON.parse(readFileSync(resolve(ROOT, 'messages/en.json'), 'utf8')).admin.entitlementTemplates;
    // The half that is still true stays; the unconditional claim goes.
    expect(en.datedNote).toContain('already in force');
    expect(en.datedNote).toContain('has not started yet');
  });
});
