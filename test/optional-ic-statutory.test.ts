/**
 * Item 35524d1f — a statutory record no longer requires a MyKad IC.
 *
 * THE DEFECT. `setStatutoryProfileMY` opened with `if (!isValidIC(p.icNumber)) throw new InvalidICError()`,
 * and a blank string fails that test as surely as a typo does. So every writer of the full statutory row
 * refused to save at all when the Identity No was empty — even though item e3ce0d4d had deliberately made
 * the IC optional (a passport holder has none), relaxed `ic_number` to nullable in 0212 and made the
 * (tenant_id, ic_number) uniqueness partial in 0214 so null rows could coexist. The write path never caught up.
 *
 * It surfaced worst on the Create Employee wizard: nothing in the wizard marks Identity No required, so the
 * refusal arrived at the LAST step, after `hireEmployee` had already committed the person — and with the
 * message "Invalid Malaysian IC number (expected 12 digits)" for a field the operator was never asked to fill.
 *
 * THE CURE is at the setter, applying the rule `setIcProfileMY` has used since 55865c32: blank or absent is
 * accepted and stored as NULL; any NON-blank value stays strict 12-digit MyKad. That fixes all three writers
 * of the full row at once — the wizard, the Personnel EPF/SOCSO card, and the Zakat election save — which is
 * why the cases below reach for each of them rather than only the reported screen.
 *
 * NOTHING STORED IS REPAIRED BY THIS. Measured on production 2026-08-05: 33 rows in employee_statutory_my,
 * none with a null ic_number. This changes what the system will ACCEPT, not what it already holds.
 *
 * Guards:
 *  (blank)   a null / '' / whitespace IC saves the row with ic_number NULL and keeps the other details.
 *  (strict)  a NON-blank invalid IC still throws InvalidICError — the relaxation must not become a hole.
 *  (wizard)  a draft with statutory details and no Identity No creates the employee and keeps them; a draft
 *            with a MALFORMED Identity No is still refused, and refused BEFORE any employee is created.
 *  (personnel-1) the EPF/SOCSO card saves for an employee whose stored IC is null (passport-identified).
 *  (personnel-2) …and a stored IC still survives that save — the full-row overwrite must not have become a wipe.
 *  (socso)   the IC-derived SOCSO/EIS number default leaves the number BLANK when there is no IC, never
 *            the string "null".
 *  (zakat)   the Zakat election's read-modify-write passes a stored null IC through instead of coercing ''.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee, updatePerson } from '../core/org';
import {
  getStatutoryProfileMY,
  InvalidICError,
  setPassportProfileMY,
  setStatutoryProfileMY,
} from '../localization/my/statutory';
import { defaultSocsoEisNumber } from '../localization/my/socso-eis';
import { completeEmployeeDraft, saveEmployeeDraft } from '../core/employee-draft';
import { type EmployeeDraftData } from '../lib/employee-draft-schema';
import { setStatutoryAction } from '../app/admin/personnel/[employmentId]/actions';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

// requireAdmin() (session) is unavailable in the harness — return the seeded admin ctx.
let ADMIN: ReturnType<typeof adminCtx>;
vi.mock('../lib/authz', () => ({ requireAdmin: async () => ADMIN }));
let LAST_REDIRECT = '';
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    LAST_REDIRECT = url;
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k }));

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

let base: Base;

describe('Optional Identity No on the statutory row (35524d1f)', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    ADMIN = adminCtx(base);
    LAST_REDIRECT = '';
  });
  afterAll(async () => {
    await closeAll();
  });

  const hire = (a: SessionContext, name: string) =>
    hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  /** The row as the database holds it — `getStatutoryProfileMY` is the read path, this is the ground truth. */
  const storedIc = async (personId: string) => {
    const [row] = await owner.db
      .select({ icNumber: schema.employeeStatutoryMy.icNumber })
      .from(schema.employeeStatutoryMy)
      .where(eq(schema.employeeStatutoryMy.personId, personId));
    return row?.icNumber ?? null;
  };

  /** The EPF/SOCSO card's payload. The card posts every control it owns on every save (full-row overwrite). */
  const statutoryForm = (e: { employmentId: string; personId: string }, over: Record<string, string> = {}) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({
      employmentId: e.employmentId,
      personId: e.personId,
      epfNumber: 'EPF-4477',
      socsoCategory: 'auto',
      eisCategory: 'auto',
      epfMode: 'auto',
      ...over,
    }))
      f.set(k, v);
    return f;
  };

  it('(blank) a null, empty or whitespace IC stores the row with ic_number NULL and keeps the rest', async () => {
    const a = adminCtx(base);
    // All three spellings reach the setter in practice: the wizard passes null, an HTML form posts '', and a
    // trimmed-to-nothing paste posts whitespace. Treating them differently would be a bug nobody would find.
    for (const ic of [null, '', '   '] as const) {
      const { personId } = await hire(a, `Blank ${randomUUID().slice(0, 8)}`);
      await setStatutoryProfileMY(a, { personId, icNumber: ic, epfNumber: 'EPF-1', bankAccountNo: '1234567890' });
      expect(await storedIc(personId), `icNumber ${JSON.stringify(ic)}`).toBeNull();
      const prof = await getStatutoryProfileMY(a, personId);
      // The point of storing rather than skipping: a foreign worker's bank details are not silently discarded.
      expect(prof?.epfNumber).toBe('EPF-1');
      expect(prof?.bankAccountNo).toBe('1234567890');
    }
  });

  it('(strict) a NON-blank invalid IC is still refused — the relaxation is not a hole', async () => {
    const a = adminCtx(base);
    const { personId } = await hire(a, 'Typo Ali');
    for (const bad of ['12345', '90010101123', 'abcdefghijkl', '9001010112345']) {
      await expect(
        setStatutoryProfileMY(a, { personId, icNumber: bad }),
        `"${bad}" must still throw`,
      ).rejects.toBeInstanceOf(InvalidICError);
    }
    // …and a good one still normalises, so the strict path is untouched.
    await setStatutoryProfileMY(a, { personId, icNumber: '900101-01-1234' });
    expect(await storedIc(personId)).toBe('900101011234');
  });

  it('(wizard) a draft with statutory details and no Identity No creates; a malformed one is refused before hiring', async () => {
    const a = adminCtx(base);
    // Everything the completion gate actually requires is filled in EXCEPT the Identity No — which is the
    // whole claim: no step marks it required, so a draft can be complete without one.
    const draft = (over: Partial<EmployeeDraftData> = {}): EmployeeDraftData => ({
      profile: {
        fullName: 'Nguyen Van An',
        primaryEmail: `an.${randomUUID().slice(0, 8)}@demo.test`,
        employeeCode: `IC${randomUUID().slice(0, 8).toUpperCase()}`,
      },
      employment: {
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-06-01',
      },
      payroll: { basicSalary: '4200' },
      ...over,
    });

    // The reported case: statutory details entered, Identity No left blank. This is the one that failed at
    // "Create Employee" AFTER the employee had already been committed.
    const { id } = await saveEmployeeDraft(a, {
      // Bank name + account number are all-or-nothing on the draft (half a bank instruction pays nobody),
      // so the pair goes in together.
      data: draft({ statutory: { epfNumber: 'E-1122', bankName: 'Maybank', bankAccountNo: '5566778899' } }),
      currentStep: 3,
    });
    const { employmentId } = await completeEmployeeDraft(a, id);
    const [emp] = await owner.db
      .select({ personId: schema.employment.personId })
      .from(schema.employment)
      .where(eq(schema.employment.id, employmentId));
    expect(await storedIc(emp.personId)).toBeNull();
    const prof = await getStatutoryProfileMY(a, emp.personId);
    expect(prof?.epfNumber).toBe('E-1122');
    expect(prof?.bankAccountNo).toBe('5566778899');

    // A TYPED but malformed Identity No is still refused, and refused by completeEmployeeDraft's own
    // pre-hire guard — so no employee and no Employee ID are consumed by the rejection. That ordering
    // matters: the draft-completion path is not one transaction, so a throw AFTER hireEmployee would leave
    // a half-created employee behind (recorded as out of scope for this item, not fixed here).
    const before = await owner.db.select({ id: schema.employment.id }).from(schema.employment);
    const bad = await saveEmployeeDraft(a, {
      data: draft({
        profile: {
          fullName: 'Typo Draft',
          primaryEmail: `typo.${randomUUID().slice(0, 8)}@demo.test`,
          employeeCode: `TY${randomUUID().slice(0, 8).toUpperCase()}`,
          icNumber: '90010101',
        },
      }),
      currentStep: 3,
    });
    await expect(completeEmployeeDraft(a, bad.id)).rejects.toThrow(/Invalid identity number/);
    const after = await owner.db.select({ id: schema.employment.id }).from(schema.employment);
    expect(after.length).toBe(before.length);
  });

  it('(personnel-1) the EPF/SOCSO card saves for a passport-identified employee whose stored IC is null', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Passport Holder');
    await updatePerson(a, {
      personId: e.personId,
      fullName: 'Passport Holder',
      primaryEmail: 'passport.holder@acme.test',
      nationality: 'Vietnamese',
    });
    // setPassportProfileMY seeds the statutory row with NO IC — this state has been reachable since e3ce0d4d,
    // which is why the Personnel card was broken for these employees before anyone filed the wizard report.
    await setPassportProfileMY(a, {
      personId: e.personId,
      passportNumber: 'B1234567',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2034-01-01',
    });
    expect(await storedIc(e.personId)).toBeNull();

    await expect(setStatutoryAction(statutoryForm(e))).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT, 'a save, not an "Invalid Malaysian IC number" bounce').toContain('toast=Saved');
    expect(await storedIc(e.personId)).toBeNull();
    const prof = await getStatutoryProfileMY(a, e.personId);
    expect(prof?.epfNumber).toBe('EPF-4477');
    // The SOCSO/EIS number default reads the IC. With none it must leave the column empty…
    expect(prof?.socsoNumber).toBeNull();
    // …and the passport identity is untouched by an EPF/SOCSO save.
    expect(prof?.passportNumber).toBe('B1234567');
  });

  it('(personnel-2) a stored IC survives the EPF/SOCSO save — the full-row overwrite is not a wipe', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Local Staff');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '880202021234' });
    await expect(setStatutoryAction(statutoryForm(e))).rejects.toThrow('NEXT_REDIRECT');
    expect(LAST_REDIRECT).toContain('toast=Saved');
    // The action reads the stored IC and passes it back. Accepting null at the setter makes an omitted IC
    // silently destructive instead of loud, so this is the case that keeps that pass-through honest.
    expect(await storedIc(e.personId)).toBe('880202021234');
  });

  it('(socso) the IC-derived SOCSO/EIS default leaves the number blank when there is no IC', async () => {
    // A Malaysian with an IC still defaults to it (the behaviour item 5a461b99 added)…
    expect(defaultSocsoEisNumber({ icNumber: '900101-01-1234', nationality: 'Malaysian' })).toBe('900101011234');
    // …and with no IC the answer is "nothing", never the string "null" written into a statutory column.
    for (const ic of [null, undefined, '', '   ']) {
      expect(defaultSocsoEisNumber({ icNumber: ic, nationality: 'Malaysian' })).toBeUndefined();
    }
    // An explicitly entered number is returned whatever the IC says.
    expect(defaultSocsoEisNumber({ socsoNumber: 'S-9', icNumber: null, nationality: 'Malaysian' })).toBe('S-9');
  });

  it('(zakat) the election save passes a stored null IC through instead of coercing it to a blank', () => {
    // Source guard rather than a behaviour test: the Zakat election is a read-modify-write of the SAME
    // full-row setter, so it carried the same `?? ''` coercion and failed identically for an employee with no
    // IC. There is no separate validation to exercise — the fault was the coercion itself.
    const src = read('app/payroll/transactions/zakat/election-actions.ts');
    expect(src).toContain('icNumber: current.icNumber,');
    expect(src, 'the coercion that made the setter refuse the save must not come back').not.toContain(
      "icNumber: current.icNumber ?? ''",
    );
    const personnel = read('app/admin/personnel/[employmentId]/actions.ts');
    expect(personnel).toContain('const icNumber = current.icNumber;');
  });
});
