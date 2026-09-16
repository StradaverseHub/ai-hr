/**
 * r293 — THE SERVER HALF of "Run Earned Accrual marks the types it can never accrue".
 *
 * The RENDERED half is test/r293-earned-accrual-picker.dom.test.tsx: both arms of the marking, the six
 * catalogues, and that a marked option is still selectable. This file holds the four things a jsdom render
 * cannot reach —
 *
 *   §1  the engine's constant, and the pin that the dom file's unavoidable COPY of it still matches;
 *   §2  that the screen DERIVES `swept` and the swept NAMES from the tenant's own rows and the engine's
 *       own constant, rather than from a second list written on the screen;
 *   §3  the three catalogue keys, in all six locales, with their placeholders;
 *   §4  ⚠️ THAT THE ENGINE ITSELF DID NOT MOVE — a real round trip through `accrueEarnedLeave` on the
 *       reporter's exact configuration, with a positive control.
 *
 * ⚠️ §4 IS THE COMMITMENT THE PLAN MADE TO THE REPORTER, AND IT IS A REFUSAL. They asked for something
 * broader: that ANY type set to Daily Accrual be picked up. `accrueEarnedLeave` keys on
 * `STANDING_LEAVE_CODES`, and so do `openLeaveYear` and `expireCarriedLeave` — ADR-0066 line 89 keeps
 * festive types outside that constant precisely "so the accrual / `openLeaveYear` / expiry engines never
 * touch them — this is the deliberate reason festive days escape annual carry-cap/forfeit". Rekeying
 * accrual alone on `accrual_method` would produce a type that earns days with no leave year opened and
 * nothing ever forfeiting: worse than the reported fault and invisible until a year-end. Three engines,
 * one boundary; they move together or not at all. This round labels a list. §4 goes red the day someone
 * smuggles the engine change in behind it.
 *
 * ⚠️ §2 IS A SOURCE-SHAPE TEST, and the reason is the same one test/r288-earned-sweep-warning.test.ts
 * gives: the derivation lives inline in a `page.tsx` default export that begins with `requireAdmin()` and
 * ends in JSX, so importing it from a node test would drag Next's request context in and prove nothing
 * about what the screen shows. What CAN be pinned without that machinery is the shape — filtered from the
 * page's existing `types` read, against `STANDING_LEAVE_CODES`, taking `name`, sorted — and that no
 * leave-type name is written anywhere in the files. The dom file then proves the component marks and
 * prints whatever it is handed. Between them there is no gap where a hardcoded "Annual Leave" survives.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave, EARNED_METHODS, STANDING_LEAVE_CODES } from '../core/leave';
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

const mkType = async (code: string, name: string) => {
  const [lt] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, paid: true, allowNegativeBalance: true })
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

describe('§1 the constant the marking is decided on', () => {
  it('the sweep covers exactly the three standing codes', () => {
    // The reporter's premise was that the process "only recognizes Hospitalization Leave and Medical
    // Leave" and excludes Annual. ANNUAL is in the constant and always has been — the account's own `AL`
    // is not. If this ever grows a fourth code the marking is not wrong, but the sentence on screen says
    // "these leave types", so the change must be a deliberate one that comes past this line.
    expect([...STANDING_LEAVE_CODES]).toEqual(['ANNUAL', 'SICK', 'HOSPITALIZATION']);
  });

  it('the dom file’s copy of the constant still matches the engine', () => {
    // WHY A COPY EXISTS AT ALL: core/leave.ts opens the database connection at module load, so the `dom`
    // vitest project — which deliberately has no env bootstrap — cannot import its values. The copy is
    // unavoidable; leaving it unpinned is not.
    const m = read(DOM_TEST).match(/const ENGINE_STANDING_CODES_COPY = \[([^\]]*)\]/);
    expect(m, `ENGINE_STANDING_CODES_COPY not found in ${DOM_TEST} — did its shape change?`).not.toBeNull();
    const copy = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean);
    expect(copy).toEqual([...STANDING_LEAVE_CODES]);
  });
});

describe('§2 the screen derives the facts — it does not restate them', () => {
  const page = read(PAGE);

  it('reads the engine’s constant instead of spelling the codes out again', () => {
    expect(page).toContain("import { STANDING_LEAVE_CODES, entitlementYearOptions } from '@/core/leave';");
    expect(page).toContain('new Set<string>([...STANDING_LEAVE_CODES])');
    // No second spelling of the constant anywhere on the screen or in the two client components it feeds:
    // a local re-listing would be free to drift from the filter it is supposed to describe.
    for (const code of STANDING_LEAVE_CODES) {
      for (const rel of [PAGE, DIALOG, CARD, POPOVER]) {
        expect(read(rel), `${rel} re-spells the code ${code}`).not.toContain(`'${code}'`);
      }
    }
    // …AND THE MARKING IS KEYED ON THE CODE, NOT ON THE EARNING METHOD. `accrueEarnedLeave` returns on the
    // code filter BEFORE it has read a method, so a festive type granted in full is exactly as unreachable
    // from this screen as a Daily Accrual one on the same non-standing code. A marking that also tested the
    // method would mark only half of what the engine declines — which is how the reporter came to be told
    // the wrong reason twice.
    for (const method of EARNED_METHODS) {
      for (const rel of [PAGE, DIALOG]) {
        expect(read(rel), `${rel} keys the marking on the method ${method}`).not.toContain(`'${method}'`);
      }
    }
    // The card DOES spell the three methods — in `methodLabel`, which captions the preview table's
    // "Accrual method" column and predates this round (bc36c768). Outside that one function there is no
    // method literal, so nothing this round added reads one.
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
    // What the marking IS keyed on: the boolean the server decided against the engine's constant.
    expect(card).toContain("optionNote={(o) => (notSweptIds.has(o.id) ? t('earnedTypeNotCoveredTag') : null)}");
    expect(card).toContain("leaveTypes.filter((o) => !o.swept)");
  });

  it('every ACTIVE type is still offered — the list is marked, not filtered', () => {
    // The scope filter is legitimately over all active types, the engine's typed empty reason (r285) is
    // still the authority on why a run found nothing, and dropping the rows would hide the very type the
    // reporter went looking for. The read is unchanged; one boolean rides along with each row.
    expect(page).toContain('listLeaveTypes(s, { includeArchived: false })');
    expect(page).toContain('swept: standingCodes.has(lt.code),');
    expect(page).not.toMatch(/accrualTypes\s*=\s*types\s*\n?\s*\.filter/);
  });

  it('the swept NAMES come from the tenant’s own rows, in name order', () => {
    // The engine's own filter at its `type_not_swept` exit: standing code AND not archived, names, A–Z.
    // `types` IS the non-archived read (asserted above), which is the second half of that filter, and the
    // page reuses the read it already makes, so this costs no query.
    expect(page).toContain('const sweptLeaveTypeNames = types');
    expect(page).toContain('.filter((lt) => standingCodes.has(lt.code))');
    expect(page).toContain('.map((lt) => lt.name)');
    expect(page).toContain('.sort((a, b) => a.localeCompare(b));');
  });

  it('NO leave-type name is written anywhere in the four touched files', () => {
    // The reporting account has two leave types both called some variant of Annual Leave. A hardcoded
    // default name would print a riddle on the very account that raised this.
    for (const rel of [PAGE, DIALOG, CARD, POPOVER]) {
      // Comments are stripped first: the file headers discuss "*Annual Leave" by name, deliberately, and
      // a scan that cannot tell prose from code lies in both directions (CLAUDE.md §8).
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
    // r123/r124 took production screens down handing a client island a closure. What crosses here is a
    // boolean per option and one array of strings; test/server-client-boundary.test.ts is the general
    // guard, this is the local pin.
    expect(page).toContain('sweptLeaveTypeNames={sweptLeaveTypeNames}');
    expect(read(DIALOG)).toContain('sweptLeaveTypeNames: string[];');
    expect(read(DIALOG)).toContain('sweptLeaveTypeNames={sweptLeaveTypeNames}');
    expect(read(CARD)).toContain('export type EarnedLeaveTypeOption = EarnedScopeOption & { swept: boolean };');
    // REQUIRED, not optional: a picker that cannot answer "would a run ever look at this type" is the
    // state this round exists to remove, and an optional flag would quietly restore it at the next mount.
    expect(read(CARD)).toContain('leaveTypes: EarnedLeaveTypeOption[];');
    expect(read(CARD)).toContain('sweptLeaveTypeNames: string[];');
  });

  it('the shared picker’s new prop is OPT-IN — the other five call sites are untouched', () => {
    const popover = read(POPOVER);
    expect(popover).toContain('optionNote?: (option: MultiSelectPopoverOption) => string | null | undefined;');
    expect(popover).toContain('const note = optionNote?.(o);');
    // Presentation-only, as the component has always been: the marker arrives already translated.
    expect(popover).not.toMatch(/useTranslations|next-intl/);
    // Exactly ONE call site passes it, and it is the leave-type axis of the accrual card.
    const callSites = ['app/payroll/dashboard-filters.tsx', 'components/attendance/location-assignment.tsx',
      'components/leave/adjustment-form.tsx', 'components/leave/generate-form.tsx',
      'components/notice/notice-form.tsx', 'components/replacement-eligibility-picker.tsx'];
    for (const rel of callSites) expect(read(rel), `${rel} unexpectedly marks options`).not.toContain('optionNote');
    expect(read(CARD).match(/optionNote=/g)).toHaveLength(1);
  });
});

describe('§3 the three catalogue keys', () => {
  const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
  const leaveOf = (loc: string) =>
    JSON.parse(read(`messages/${loc}.json`)).admin.leave as Record<string, string>;

  it('exist, are non-empty, and carry the right placeholders in all six locales', () => {
    for (const loc of LOCALES) {
      const L = leaveOf(loc);
      expect(L.earnedTypeNotCoveredTag, `${loc}: earnedTypeNotCoveredTag`).toBeTruthy();
      expect(L.earnedTypesNotSwept, `${loc}: earnedTypesNotSwept`).toBeTruthy();
      expect(L.earnedTypesNotSweptNoneActive, `${loc}: earnedTypesNotSweptNoneActive`).toBeTruthy();
      // The names arrive ONLY through the placeholders. A bare t() on an ICU string throws
      // FORMATTING_ERROR and renders the key path, so a lost placeholder is a broken screen.
      expect(L.earnedTypesNotSwept, `${loc}: lost {swept}`).toContain('{swept}');
      expect(L.earnedTypesNotSwept, `${loc}: lost {types}`).toContain('{types}');
      expect(L.earnedTypesNotSweptNoneActive, `${loc}: lost {types}`).toContain('{types}');
      // The none-active sentence names nothing covered, because on that account there is nothing to name.
      expect(L.earnedTypesNotSweptNoneActive, `${loc}: stray {swept}`).not.toContain('{swept}');
      // The row marker is a marker: no placeholder, and short enough to sit beside a name.
      expect(L.earnedTypeNotCoveredTag, `${loc}: marker takes a placeholder`).not.toContain('{');
    }
  });

  it('are translated — not six copies of the English string', () => {
    const en = leaveOf('en');
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const L = leaveOf(loc);
      for (const k of ['earnedTypeNotCoveredTag', 'earnedTypesNotSwept', 'earnedTypesNotSweptNoneActive']) {
        expect(L[k], `${loc}.${k} is untranslated English`).not.toBe(en[k]);
      }
    }
  });
});

describe('§4 ⚠️ THE ENGINE IS UNTOUCHED — accrual still keys on the CODE, never on the method', () => {
  it('an ACTIVE Daily Accrual type on a NON-standing code still accrues nothing, and says why', async () => {
    // The reporter's account, reproduced: an ACTIVE `AL` set to Daily Accrual, with an entitlement table
    // in force and an eligibility rule that reaches the employee — everything the screen asks for.
    const al = await mkType('AL', '*Annual Leave');
    await setMethod(al, 'earned_daily');
    await configure(al);
    await hire();

    const res = await run({ asOf: MID, leaveTypeIds: [al], dryRun: true });
    expect(res.breakdown).toHaveLength(0);
    expect(res.granted).toBe(0);
    expect(res.emptyReason?.kind).toBe('type_not_swept');

    // POSITIVE CONTROL — the identical configuration on a type the sweep DOES cover previews rows. Without
    // it these assertions hold just as well against an engine that can never produce anything.
    await setMethod(b.annualLeaveTypeId, 'earned_daily');
    await configure(b.annualLeaveTypeId);
    const ok = await run({ asOf: MID, leaveTypeIds: [b.annualLeaveTypeId], dryRun: true });
    expect(ok.breakdown.length).toBeGreaterThan(0);
    expect(ok.emptyReason).toBeNull();
  });

  it('the filter is still `code IN STANDING_LEAVE_CODES`, ahead of any method test', () => {
    // The source pin beside the behavioural one, because the behaviour above could also be satisfied by a
    // method filter that happened to decline the same row. ADR-0066 line 89 is the reason this line stays:
    // festive types live outside the constant so the accrual / openLeaveYear / expiry engines never touch
    // them, which is why festive days escape the annual carry cap.
    const engine = read(ENGINE);
    expect(engine).toContain('inArray(leaveType.code, [...STANDING_LEAVE_CODES]),');
    const adr = read('docs/adr/0066-configurable-entitlement-per-company.md');
    expect(adr).toContain('so the accrual / `openLeaveYear` / expiry engines never touch them');
  });
});
