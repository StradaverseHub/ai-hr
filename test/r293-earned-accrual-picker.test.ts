/**
 * r293 — THE SERVER HALF of "Run Earned Accrual marks the types it can never accrue".
 * r299 (3de1453a) — UPDATED, NOT DELETED: the decision this file pinned has been REVERSED on the reporter's
 * explicit instruction, and every section below now pins the new decision instead of the old one.
 *
 * WHAT r293 PINNED, AND WHY IT NO LONGER HOLDS. r293 kept `accrueEarnedLeave` keyed on
 * `STANDING_LEAVE_CODES` (ANNUAL · SICK · HOSPITALIZATION) and only MARKED the other types in the picker,
 * refusing the reporter's broader ask. The reporter then stated the rule outright: "Only Annual Leave
 * (*Annual Leave) is subject to the Earned Accrual concept. All other leave types are managed based on
 * entitlement and should not be included in the Earned Accrual process." So the sweep now keys on ONE
 * predicate, `isEarnedAccrualType` (role 'annual' first, the seeded code ANNUAL for an unclassified row) —
 * NARROWER than the constant, not wider: SICK and HOSPITALIZATION leave it, and nothing keys on
 * `accrual_method` alone. r293's ADR-0066 §89 worry (a festive type that "earns days with no leave year
 * opened and nothing ever forfeiting") is therefore untouched: festive types are not Annual Leave.
 *
 *   §1  the predicate the marking is decided on, and the pin that the dom file's COPY of its fixture shape
 *       still matches what the server sends;
 *   §2  that the screen DERIVES `swept` and the Annual Leave NAMES from the tenant's own rows and the
 *       engine's own predicate, rather than from a second rule written on the screen;
 *   §3  the catalogue keys, in all six locales, with their placeholders (r293's three keys are retired);
 *   §4  ⚠️ THE ENGINE, round-tripped on the reporter's exact configuration, with a positive control.
 *
 * ⚠️ §2 IS A SOURCE-SHAPE TEST for the reason r293 gave: the derivation lives inline in a `page.tsx` default
 * export that begins with `requireAdmin()` and ends in JSX. test/r299-earned-accrual-annual-only.test.ts
 * holds the behavioural engine and service arms; the dom file holds the rendered picker.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, EARNED_METHODS, isEarnedAccrualType, STANDING_LEAVE_CODES } from '../core/leave';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const here = __dirname;
const read = (rel: string) => readFileSync(resolve(here, '..', rel), 'utf8');

const PAGE = 'app/admin/leave-config/earned-accrual/page.tsx';
const DIALOG = 'components/leave/earned-accrual-dialog.tsx';
const CARD = 'components/earned-accrual-card.tsx';
const POPOVER = 'components/ui/multi-select-popover.tsx';
const DOM_TEST = 'test/r293-earned-accrual-picker.dom.test.tsx';
const ENGINE = 'core/leave.ts';

// Dates derive from the clock, never hardcoded: an assertion pinned to a literal year silently stops
// meaning anything the moment the calendar passes it.
const YEAR = Number(todayInKualaLumpur().slice(0, 4));
const JAN = `${YEAR}-01-01`;
const MID = `${YEAR}-06-15`;

let b: Base;

const run = (p: Parameters<typeof accrueEarnedLeave>[1]) => accrueEarnedLeave(adminCtx(b), p);

const mkType = async (code: string, name: string, role: schema.LeaveTypeRoleValue | null = null) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, role, paid: true, allowNegativeBalance: true })
    .returning({ id: schema.leaveType.id });
  return lt.id;
};

const setMethod = (leaveTypeId: string, method: string) =>
  owner.db
    .update(schema.leaveType)
    .set({ accrualMethod: method as never })
    .where(eq(schema.leaveType.id, leaveTypeId));

/** A fully configured earned type: entitlement template + an eligibility rule that reaches everybody. */
const configure = (leaveTypeId: string) =>
  seedEntitlement(adminCtx(b), { leaveTypeId, annualDays: 12, gradeId: null, validFrom: JAN });

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Acc', primaryEmail: `acc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: JAN,
    gradeId: null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(closeAll);

describe('§1 the predicate the marking is decided on', () => {
  it('Earned Accrual covers Annual Leave only — role first, the seeded code for an unclassified row', () => {
    // r293 pinned "exactly the three standing codes" here. The reporter's rule retired that from the sweep:
    // SICK and HOSPITALIZATION are entitlement-based, and a type switched on by ROLE is Annual Leave
    // whatever its code. The constant itself is untouched because openLeaveYear still reads it.
    expect(isEarnedAccrualType({ role: null, code: 'ANNUAL' })).toBe(true);
    expect(isEarnedAccrualType({ role: 'annual', code: 'AL' })).toBe(true);
    for (const code of STANDING_LEAVE_CODES.filter((c) => c !== 'ANNUAL')) {
      expect(isEarnedAccrualType({ role: null, code }), code).toBe(false);
    }
    expect([...STANDING_LEAVE_CODES]).toEqual(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
  });

  it('the dom file’s fixture marks exactly the rows this predicate would', () => {
    // WHY A COPY EXISTS AT ALL: core/leave.ts opens the database connection at module load, so the `dom`
    // vitest project cannot import its values. r293 pinned a copy of the constant; r299's dom file carries
    // its fixture rows WITH the (role, code) each stands for, and this reads them back and asks the real
    // predicate — so a fixture claiming `swept: true` for a SICK row goes red here.
    const src = read(DOM_TEST);
    const rows = [...src.matchAll(/\{ id: '[^']+', name: [A-Z_]+, swept: (true|false) \}, \/\/ role=([a-z]*) code=([A-Z_]+)/g)];
    expect(rows.length, `no annotated fixture rows found in ${DOM_TEST} — did its shape change?`).toBeGreaterThan(3);
    for (const [, swept, role, code] of rows) {
      expect(isEarnedAccrualType({ role: role || null, code }), `${role}/${code}`).toBe(swept === 'true');
    }
  });
});

describe('§2 the screen derives the facts — it does not restate them', () => {
  const page = read(PAGE);

  it('reads the engine’s predicate instead of spelling the rule out again', () => {
    expect(page).toContain("import { entitlementYearOptions, isEarnedAccrualType } from '@/core/leave';");
    // No second spelling of the rule anywhere on the screen or in the client components it feeds: no code
    // literal, no role literal.
    for (const rel of [PAGE, DIALOG, CARD, POPOVER]) {
      for (const code of STANDING_LEAVE_CODES) {
        expect(read(rel), `${rel} re-spells the code ${code}`).not.toContain(`'${code}'`);
      }
      expect(read(rel), `${rel} re-spells the role`).not.toContain(`'annual'`);
    }
    // …AND THE MARKING IS NOT KEYED ON THE EARNING METHOD. The engine declines a non-Annual type before it
    // has read a method, so a festive type granted in full is exactly as out of scope as a Daily Accrual
    // one. The card DOES spell the methods — in `methodLabel`, which captions the preview's "Accrual
    // method" column and predates r293 (bc36c768) — and nowhere else.
    for (const method of EARNED_METHODS) {
      for (const rel of [PAGE, DIALOG]) {
        expect(read(rel), `${rel} keys the marking on the method ${method}`).not.toContain(`'${method}'`);
      }
    }
    const card = read(CARD);
    const labelStart = card.indexOf('const methodLabel');
    const labelEnd = card.indexOf("t('earnedMethodMonthly');", labelStart);
    expect(labelStart, 'methodLabel moved — re-check what this slice excludes').toBeGreaterThan(-1);
    expect(labelEnd).toBeGreaterThan(labelStart);
    const cardOutsideMethodLabel = card.slice(0, labelStart) + card.slice(labelEnd);
    for (const method of EARNED_METHODS) {
      expect(cardOutsideMethodLabel, `${CARD} reads the method ${method} outside methodLabel`).not.toContain(
        `'${method}'`,
      );
    }
    // What the picker IS keyed on: the boolean the server decided with the engine's predicate.
    expect(card).toContain("leaveTypes.filter((o) => !o.swept)");
    expect(card).toContain('optionDisabled={(o) => notSweptIds.has(o.id)}');
  });

  it('every ACTIVE type is still offered — listed, not filtered; the others are disabled, not removed', () => {
    expect(page).toContain('listLeaveTypes(s, { includeArchived: false })');
    expect(page).toContain('swept: isEarnedAccrualType(lt),');
    expect(page).not.toMatch(/accrualTypes\s*=\s*types\s*\n?\s*\.filter/);
  });

  it('the Annual Leave NAMES come from the tenant’s own rows, in name order', () => {
    // The engine's own filter at its `type_not_swept` exit: the predicate AND not archived, names, A–Z.
    expect(page).toContain('const sweptLeaveTypeNames = accrualTypes');
    expect(page).toContain('.filter((lt) => lt.swept)');
    expect(page).toContain('.map((lt) => lt.name)');
    expect(page).toContain('.sort((a, b) => a.localeCompare(b));');
  });

  it('NO tenant leave-type name is written anywhere in the four touched files', () => {
    // The reporter's sentence carries THEIR name in brackets. A hardcoded default would print the wrong one.
    for (const rel of [PAGE, DIALOG, CARD, POPOVER]) {
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
    expect(page).toContain('sweptLeaveTypeNames={sweptLeaveTypeNames}');
    expect(read(DIALOG)).toContain('sweptLeaveTypeNames: string[];');
    expect(read(DIALOG)).toContain('sweptLeaveTypeNames={sweptLeaveTypeNames}');
    expect(read(CARD)).toContain('export type EarnedLeaveTypeOption = EarnedScopeOption & { swept: boolean };');
    // REQUIRED, not optional: an optional flag would quietly default and re-enable a row at the next mount.
    expect(read(CARD)).toContain('leaveTypes: EarnedLeaveTypeOption[];');
    expect(read(CARD)).toContain('sweptLeaveTypeNames: string[];');
  });

  it('the shared picker’s two props are OPT-IN — the other call sites are untouched', () => {
    const popover = read(POPOVER);
    expect(popover).toContain('optionNote?: (option: MultiSelectPopoverOption) => MultiSelectOptionNote | null | undefined;');
    expect(popover).toContain('optionDisabled?: (option: MultiSelectPopoverOption) => boolean;');
    expect(popover).toContain('const note = optionNote?.(o);');
    // Select all must not tick a disabled row.
    expect(popover).toContain('const selectAll = () => onChange(new Set([...selected, ...selectableVisibleIds]));');
    // Presentation-only, as the component has always been: the tag arrives already translated.
    expect(popover).not.toMatch(/useTranslations|next-intl/);
    const callSites = ['app/payroll/dashboard-filters.tsx', 'components/attendance/location-assignment.tsx',
      'components/leave/adjustment-form.tsx', 'components/leave/generate-form.tsx',
      'components/notice/notice-form.tsx', 'components/replacement-eligibility-picker.tsx'];
    for (const rel of callSites) {
      expect(read(rel), `${rel} unexpectedly marks options`).not.toContain('optionNote');
      expect(read(rel), `${rel} unexpectedly disables options`).not.toContain('optionDisabled');
    }
    expect(read(CARD).match(/optionNote=/g)).toHaveLength(1);
    expect(read(CARD).match(/optionDisabled=/g)).toHaveLength(1);
  });
});

describe('§3 the catalogue keys', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const leaveOf = (loc: string) =>
    JSON.parse(read(`messages/${loc}.json`)).admin.leave as Record<string, string>;
  const NEW_KEYS = ['earnedTypeEarnedTag', 'earnedTypeEntitlementTag', 'earnedAnnualOnly', 'earnedAnnualOnlyNoneActive'];

  it('exist, are non-empty, and carry the right placeholders in all six locales', () => {
    for (const loc of LOCALES) {
      const L = leaveOf(loc);
      for (const k of NEW_KEYS) expect(L[k], `${loc}: ${k}`).toBeTruthy();
      // The tenant's Annual Leave name(s) arrive ONLY through the placeholder.
      expect(L.earnedAnnualOnly, `${loc}: lost {names}`).toContain('{names}');
      expect(L.earnedAnnualOnlyNoneActive, `${loc}: stray {names}`).not.toContain('{names}');
      // The two tags are tags: no placeholder, short enough to sit beside a name.
      expect(L.earnedTypeEarnedTag, `${loc}: tag takes a placeholder`).not.toContain('{');
      expect(L.earnedTypeEntitlementTag, `${loc}: tag takes a placeholder`).not.toContain('{');
    }
  });

  it('r293’s three keys are retired in every locale, and nothing reads them', () => {
    for (const loc of LOCALES) {
      const L = leaveOf(loc);
      for (const k of ['earnedTypeNotCoveredTag', 'earnedTypesNotSwept', 'earnedTypesNotSweptNoneActive']) {
        expect(L[k], `${loc}.${k} survived`).toBeUndefined();
      }
    }
    for (const rel of [PAGE, DIALOG, CARD, POPOVER]) {
      expect(read(rel)).not.toMatch(/earnedTypeNotCoveredTag|earnedTypesNotSwept/);
    }
  });

  it('are translated — not six copies of the English string', () => {
    const en = leaveOf('en');
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const L = leaveOf(loc);
      for (const k of NEW_KEYS) {
        expect(L[k], `${loc}.${k} is untranslated English`).not.toBe(en[k]);
      }
    }
  });

  it('the English sentence is the reporter’s, word for word, around the placeholder', () => {
    expect(leaveOf('en').earnedAnnualOnly).toBe(
      'Earned Accrual applies only to Annual Leave ({names}). Other leave types are entitlement-based and are excluded from this process.',
    );
  });
});

describe('§4 ⚠️ THE ENGINE — Annual Leave only, keyed on the predicate, never on the method', () => {
  it('the reporter’s `AL` "*Annual Leave", switched on, accrues; a Daily Accrual SICK type does not', async () => {
    // The reporter's account, reproduced: the seeded ANNUAL archived, an ACTIVE `AL` set to Daily Accrual
    // with an entitlement table in force and an eligibility rule that reaches the employee. r293 pinned that
    // this accrued NOTHING (`type_not_swept`); with the role written by "This is our Annual Leave", it does.
    await hire();
    await owner.db.update(schema.leaveType).set({ archivedAt: new Date() }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const al = await mkType('AL', '*Annual Leave', 'annual');
    await setMethod(al, 'earned_daily');
    await configure(al);

    const res = await run({ asOf: MID, leaveTypeIds: [al], dryRun: true });
    expect(res.emptyReason).toBeNull();
    expect(res.breakdown.length).toBeGreaterThan(0);

    // …and the identical configuration on SICK — which r293 swept — is declined, by name.
    const sick = await mkType('SICK', 'Medical Leave');
    await setMethod(sick, 'earned_daily');
    await configure(sick);
    const declined = await run({ asOf: MID, leaveTypeIds: [sick], dryRun: true });
    expect(declined.breakdown).toHaveLength(0);
    expect(declined.emptyReason).toEqual({
      kind: 'type_not_swept',
      leaveTypeNames: ['Medical Leave'],
      sweptLeaveTypeNames: ['*Annual Leave'],
    });
  });

  it('the filter is the predicate, ahead of any method test', () => {
    // The source pin beside the behavioural one, because the behaviour above could also be satisfied by a
    // method filter that happened to decline the same row.
    const engine = read(ENGINE);
    const start = engine.indexOf('export async function accrueEarnedLeave(');
    const body = engine.slice(start, engine.indexOf('\n}\n', start));
    const filterAt = body.indexOf('const types = activeTypes.filter((t) => isEarnedAccrualType(t));');
    expect(filterAt).toBeGreaterThan(-1);
    expect(filterAt).toBeLessThan(body.indexOf('isEarnedMethod(t.accrualMethod)'));
    // ADR-0066 §89's reason still holds and is still true: festive types are outside the sweep.
    const adr = read('docs/adr/0066-configurable-entitlement-per-company.md');
    expect(adr).toContain('so the accrual / `openLeaveYear` / expiry engines never touch them');
  });
});
