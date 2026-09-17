/**
 * feedback 686dc512 (r288) — THE SERVER HALF of the leave type editor's earned-sweep facts.
 * r299 (3de1453a) — UPDATED, NOT DELETED. r288 WARNED and deliberately did not refuse ("a tenant may
 * legitimately keep such a type for a non-accruing purpose"). The reporter's rule — "Only Annual Leave
 * (*Annual Leave) is subject to the Earned Accrual concept. All other leave types are managed based on
 * entitlement and should not be included in the Earned Accrual process." — REVERSES that: the writer now
 * refuses a change to an earned method on anything that is not Annual Leave, and the editor carries the
 * "This is our Annual Leave" switch. Each section below pins the new decision in the place the old one sat.
 *
 * The RENDERED half is test/r288-earned-sweep-warning.dom.test.tsx. This file holds what jsdom cannot reach —
 *
 *   §1  the engine's earned-method family, and the pin that the dom file's COPY of it still matches;
 *   §2  that the screen DERIVES the facts from the tenant's own rows and the engine's own predicate;
 *   §3  REFUSE, AND NEVER REWRITE — a real round trip through the real writer, both arms;
 *   §4  the catalogue keys (r288's two warning keys retired; the switch and note keys added).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { createLeaveType, LeaveTypeRuleError, setLeaveTypeRules } from '../core/admin';
import { EARNED_METHODS, STANDING_LEAVE_CODES, isEarnedAccrualType, isEarnedMethod } from '../core/leave';

const here = __dirname;
const read = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

const PAGE = 'app/admin/leave-config/types/page.tsx';
const TABS = 'app/admin/leave-config/types/leave-type-tabs.tsx';
const FORMS = 'app/admin/leave-config/types/leave-type-sub-forms.tsx';
const DOM_TEST = 'test/r288-earned-sweep-warning.dom.test.tsx';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

describe('§1 the engine facts the editor is decided on', () => {
  it('Earned Accrual covers Annual Leave only (the predicate), and the constant is left alone', () => {
    expect(isEarnedAccrualType({ role: null, code: 'ANNUAL' })).toBe(true);
    expect(isEarnedAccrualType({ role: 'annual', code: 'AL' })).toBe(true);
    expect(isEarnedAccrualType({ role: null, code: 'SICK' })).toBe(false);
    expect([...STANDING_LEAVE_CODES]).toEqual(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
  });

  it('the earned family is three methods, and the legacy one is still in it', () => {
    expect([...EARNED_METHODS]).toEqual(['earned_monthly', 'earned_quarterly', 'earned_daily']);
    // The dropdown no longer offers quarterly; a row that still stores it renders on the read-only branch,
    // and on a type that is not Annual Leave it is just as stranded. The dom file pins that it says so.
    expect(isEarnedMethod('earned_quarterly')).toBe(true);
    expect(isEarnedMethod('grant_on_hire_prorated')).toBe(false);
  });

  it('the dom file’s copy of the earned family still matches the engine', () => {
    // core/leave.ts opens the database connection at module load, so the `dom` project cannot import its
    // values. The copy is unavoidable; leaving it unpinned is not.
    const m = read(DOM_TEST).match(/const ENGINE_EARNED_METHODS_COPY = \[([^\]]*)\]/);
    expect(m, `ENGINE_EARNED_METHODS_COPY not found in ${DOM_TEST} — did its shape change?`).not.toBeNull();
    const copy = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(copy).toEqual([...EARNED_METHODS]);
  });
});

describe('§2 the screen derives the facts — it does not restate them', () => {
  const page = read(PAGE);

  it('reads the engine’s predicate and family instead of spelling either out again', () => {
    expect(page).toContain("import { EARNED_METHODS, annualLeaveSwitchState, isEarnedAccrualType } from '@/core/leave';");
    expect(page).toContain('const earnedMethods = [...EARNED_METHODS];');
    // No second spelling of the rule anywhere on the screen: no code literal, no role literal.
    for (const rel of [PAGE, TABS, FORMS]) {
      for (const code of STANDING_LEAVE_CODES) {
        expect(read(rel), `${rel} re-spells the code ${code}`).not.toContain(`'${code}'`);
      }
      expect(read(rel), `${rel} re-spells the role`).not.toContain(`'annual'`);
    }
  });

  it('the Annual Leave NAMES come from the tenant’s own rows, active only, in name order', () => {
    expect(page).toContain('const activeAnnualLeave = types');
    expect(page).toContain('.filter((lt) => !lt.archivedAt && isEarnedAccrualType(lt))');
    expect(page).toContain('.sort((a, b) => a.name.localeCompare(b.name));');
    // …and each panel is told the OTHER ones, never its own.
    expect(page).toContain('otherAnnualLeaveTypeNames: activeAnnualLeave.filter((a) => a.id !== lt.id).map((a) => a.name),');
  });

  it('NO tenant leave-type name is written anywhere on the three touched files', () => {
    for (const rel of [PAGE, TABS, FORMS]) {
      const code = read(rel)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      for (const name of ['Annual Leave', 'Medical Leave', 'Hospitalization Leave', 'Sick Leave']) {
        expect(code, `${rel} hardcodes ${name}`).not.toContain(name);
      }
    }
  });

  it('the facts cross the server/client boundary as plain data', () => {
    expect(page).toContain('annualSwitch: annualLeaveSwitchState(lt),');
    expect(page).toContain('leaveTypeName: lt.name,');
    expect(read(TABS)).toContain('sweep: EarnedSweepFacts;');
    expect(read(TABS)).toContain('sweep={sweep}');
    expect(read(FORMS)).toContain('sweep: EarnedSweepFacts;');
    expect(read(FORMS)).toContain("annualSwitch: 'on' | 'off' | 'by_code' | 'other_role';");
  });

  it('Monthly and Daily are LISTED but disabled unless the switch is on, and the switch posts its own marker', () => {
    const form = read(FORMS).slice(
      read(FORMS).indexOf('function EarningMethodForm'),
      read(FORMS).indexOf('function CarryPolicyForm'),
    );
    expect(form).toContain('<option value="monthly" disabled={!annualOn}>');
    expect(form).toContain('<option value="daily" disabled={!annualOn}>');
    // The None choice is never disabled — it is what every other leave type is offered.
    expect(form).toContain('<option value="none">');
    expect(form).toContain('<input type="hidden" name="annualLeaveRendered" value="1" />');
    expect(form).toContain("<input type=\"hidden\" name=\"isAnnualLeave\" value={annualOn ? '1' : '0'} />");
    // The marker is posted only while the switch is editable — a locked switch touches no role.
    const markerAt = form.indexOf('name="annualLeaveRendered"');
    expect(form.lastIndexOf('{switchEditable && (', markerAt)).toBeGreaterThan(-1);
  });
});

describe('§3 REFUSE A NEW EARNED METHOD, NEVER REWRITE A STORED ONE — the writer', () => {
  const rulesOf = async (id: string) => {
    const [row] = await owner.db
      .select({
        code: schema.leaveType.code,
        role: schema.leaveType.role,
        accrualMethod: schema.leaveType.accrualMethod,
        accrualDay: schema.leaveType.accrualDay,
      })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, id))
      .limit(1);
    return row!;
  };

  it('an earned method on a type that is not Annual Leave is REFUSED, and the row is untouched', async () => {
    // r288 pinned the opposite ("accepted and stored unchanged"). The reporter's rule reverses it.
    const created = await createLeaveType(adminCtx(b), { code: 'AL', name: '*Annual Leave' });
    let refused: unknown = null;
    try {
      await setLeaveTypeRules(adminCtx(b), { id: created.id, accrualMethod: 'earned_monthly', accrualDay: 5 });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(LeaveTypeRuleError);
    expect(await rulesOf(created.id)).toMatchObject({ code: 'AL', role: null, accrualMethod: null, accrualDay: null });
  });

  it('…and the SAME call on Annual Leave stores it — the refusal is about the type, not the method', async () => {
    // The positive arm, on the seeded ANNUAL (unclassified, Annual Leave by its code)…
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_monthly', accrualDay: 5 });
    expect(await rulesOf(b.annualLeaveTypeId)).toMatchObject({ accrualMethod: 'earned_monthly', accrualDay: 5 });
    // …and on a custom code switched on in the same save, once the seeded one is archived.
    await owner.db.update(schema.leaveType).set({ archivedAt: new Date() }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const al = await createLeaveType(adminCtx(b), { code: 'AL', name: '*Annual Leave' });
    await setLeaveTypeRules(adminCtx(b), { id: al.id, isAnnualLeave: true, accrualMethod: 'earned_monthly', accrualDay: 5 });
    expect(await rulesOf(al.id)).toMatchObject({ role: 'annual', accrualMethod: 'earned_monthly', accrualDay: 5 });
  });

  it('a method stored BEFORE the rule is kept byte-for-byte when the form re-posts it', async () => {
    const created = await createLeaveType(adminCtx(b), { code: 'MC', name: 'MC' });
    await owner.db.update(schema.leaveType).set({ accrualMethod: 'earned_quarterly' }).where(eq(schema.leaveType.id, created.id));
    await setLeaveTypeRules(adminCtx(b), { id: created.id, accrualMethod: 'earned_quarterly', roundingMethod: null });
    expect((await rulesOf(created.id)).accrualMethod).toBe('earned_quarterly');
  });
});

describe('§4 the catalogue keys', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const subStepOf = (loc: string) =>
    JSON.parse(read(`messages/${loc}.json`)).admin.leave.subStep as Record<string, string>;
  const NEW_KEYS = [
    'annualLeaveSwitchLabel',
    'annualLeaveSwitchOnHelp',
    'annualLeaveSwitchOffHelp',
    'annualLeaveSwitchOtherHelp',
    'annualLeaveSwitchByCodeHelp',
    'annualLeaveSwitchOtherRoleHelp',
    'annualLeaveSwitchHeldHelp',
    'earningEntitlementBasedNote',
    'earningStrandedNote',
  ];

  it('exist, are non-empty, and carry the right placeholders in all six locales', () => {
    for (const loc of LOCALES) {
      const sub = subStepOf(loc);
      for (const k of NEW_KEYS) expect(sub[k], `${loc}: ${k}`).toBeTruthy();
      expect(sub.annualLeaveSwitchOtherHelp, `${loc}: lost {names}`).toContain('{names}');
      expect(sub.earningEntitlementBasedNote, `${loc}: lost {type}`).toContain('{type}');
      expect(sub.earningStrandedNote, `${loc}: lost {type}`).toContain('{type}');
      // The option is named through its own label, so the note and the dropdown cannot disagree.
      expect(sub.earningStrandedNote, `${loc}: lost {none}`).toContain('{none}');
      for (const p of ['{none}', '{monthly}', '{daily}']) {
        expect(sub.annualLeaveSwitchHeldHelp, `${loc}: lost ${p}`).toContain(p);
      }
    }
  });

  it('r288’s two warning keys are retired in every locale, and nothing reads them', () => {
    for (const loc of LOCALES) {
      const sub = subStepOf(loc);
      expect(sub.earningNotSwept, `${loc}.earningNotSwept survived`).toBeUndefined();
      expect(sub.earningNotSweptNoneActive, `${loc}.earningNotSweptNoneActive survived`).toBeUndefined();
    }
    for (const rel of [PAGE, TABS, FORMS]) expect(read(rel)).not.toContain('earningNotSwept');
  });

  it('are translated — not six copies of the English string', () => {
    const en = subStepOf('en');
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const sub = subStepOf(loc);
      for (const k of NEW_KEYS) expect(sub[k], `${loc}.${k} is untranslated English`).not.toBe(en[k]);
    }
  });
});
