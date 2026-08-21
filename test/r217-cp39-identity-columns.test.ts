/**
 * e4b541c6 — THE TWO CP39 COLUMNS THAT HAD NO DATA BEHIND THEM.
 *
 * `lib/cp39-form.ts` carried `oldIc` and `countryCode` as fields from the day it was written, each with a
 * header saying it was PERMANENTLY EMPTY because nothing in the schema could produce it. Migration 0450
 * gave them columns. This file pins both ends: that the columns store what HR types, and that the CP39
 * read carries them onto the row the form prints.
 *
 * ⚠️ THE COUNTRY CODE IS A SEPARATE COLUMN ON PURPOSE, and the case at the bottom is the one that says
 * why: `passport_issuing_country` is fed from the tenant's NATIONALITY list, so it holds "Malaysian",
 * while the CP39 wants "MY". Deriving one from the other would print an invented country code on a tax
 * document, so the two are stored apart and neither is computed from the other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setIcProfileMY, setPassportProfileMY, getStatutoryProfileMY } from '../localization/my/statutory';

let b: Base;
let ctx: ReturnType<typeof adminCtx>;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  ctx = adminCtx(b);
});

let n = 0;
async function hire(fullName = 'CP39 Person') {
  n += 1;
  const e = await hireEmployee(ctx, {
    person: { fullName, primaryEmail: `cp39_${n}_${Date.now()}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e;
}

const rowOf = (personId: string) =>
  owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId, personId)).limit(1);

describe('e4b541c6 — the old identity card number', () => {
  it('is stored as free text, WITHOUT the MyKad validation the new card gets', async () => {
    const e = await hire();
    // A pre-1990 card is not 12 digits. The strict validator beside it would refuse this.
    await setIcProfileMY(ctx, { personId: e.personId, icNumber: '900101011234', oldIcNumber: 'A 1234567' });
    const [row] = await rowOf(e.personId);
    expect(row.icNumber).toBe('900101011234');
    expect(row.oldIcNumber).toBe('A 1234567');
  });

  it('an employee with ONLY an old card is still saved — the blank new card no longer no-ops it away', async () => {
    const e = await hire();
    const res = await setIcProfileMY(ctx, { personId: e.personId, icNumber: '', oldIcNumber: '7654321' });
    expect(res.id).not.toBeNull();
    const [row] = await rowOf(e.personId);
    expect(row.icNumber).toBeNull();
    expect(row.oldIcNumber).toBe('7654321');
  });

  it('saving only the old card does NOT wipe an existing MyKad', async () => {
    const e = await hire();
    await setIcProfileMY(ctx, { personId: e.personId, icNumber: '900101011234' });
    await setIcProfileMY(ctx, { personId: e.personId, icNumber: '', oldIcNumber: 'A 1234567' });
    const [row] = await rowOf(e.personId);
    expect(row.icNumber).toBe('900101011234'); // still there
    expect(row.oldIcNumber).toBe('A 1234567');
  });

  it('still no-ops when there is nothing at all to save, exactly as before', async () => {
    const e = await hire();
    const res = await setIcProfileMY(ctx, { personId: e.personId, icNumber: '', oldIcNumber: '' });
    expect(res.id).toBeNull();
    expect(await rowOf(e.personId)).toHaveLength(0);
  });

  it('a blank old card CLEARS a stored one — the field is always submitted, so presence cannot mean "keep"', async () => {
    const e = await hire();
    await setIcProfileMY(ctx, { personId: e.personId, icNumber: '900101011234', oldIcNumber: 'A 1234567' });
    await setIcProfileMY(ctx, { personId: e.personId, icNumber: '900101011234', oldIcNumber: '' });
    const [row] = await rowOf(e.personId);
    expect(row.oldIcNumber).toBeNull();
  });
});

describe('e4b541c6 — the passport issuing country CODE', () => {
  it('is stored uppercased, in its own column, beside the demonym it is NOT derived from', async () => {
    const e = await hire('Foreign Worker');
    await setPassportProfileMY(ctx, {
      personId: e.personId,
      passportNumber: 'A1234567',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2030-01-01',
      // What the existing picker writes: a NATIONALITY, from the tenant's own option list.
      passportIssuingCountry: 'Malaysian',
      // What the CP39 needs: an ISO alpha-2, chosen by HR. Lowercased on the way in to prove it is cased.
      passportIssuingCountryCode: 'my',
    });
    const [row] = await rowOf(e.personId);
    expect(row.passportIssuingCountry).toBe('Malaysian');
    expect(row.passportIssuingCountryCode).toBe('MY');
    // THE POINT: "Malaysian" is not "MY". Nothing in the system turns one into the other, and this
    // assertion is what stops somebody adding a helpful mapping later.
    expect(row.passportIssuingCountryCode).not.toBe(row.passportIssuingCountry);
  });

  it('is optional — a passport with no code stores null rather than guessing one', async () => {
    const e = await hire('No Code');
    await setPassportProfileMY(ctx, {
      personId: e.personId,
      passportNumber: 'B7654321',
      passportIssueDate: '2024-01-01',
      passportExpiryDate: '2030-01-01',
      passportIssuingCountry: 'Singaporean',
    });
    const [row] = await rowOf(e.personId);
    expect(row.passportIssuingCountryCode).toBeNull();
  });

  it('the profile read hands both new columns back', async () => {
    const e = await hire();
    await setIcProfileMY(ctx, { personId: e.personId, icNumber: '900101011234', oldIcNumber: 'A 1234567' });
    const got = await getStatutoryProfileMY(ctx, e.personId);
    expect(got?.oldIcNumber).toBe('A 1234567');
  });
});

describe('e4b541c6 — the CP39 read carries them, and the stale comments are gone', () => {
  it('the row builders read the columns instead of hard-coding an empty string', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const ROOT = path.resolve(__dirname, '..');
    const form = fs.readFileSync(path.join(ROOT, 'localization/my/cp39-form.ts'), 'utf8');
    const reports = fs.readFileSync(path.join(ROOT, 'localization/my/reports.ts'), 'utf8');
    expect(form).toContain('oldIc: employeeStatutoryMy.oldIcNumber');
    expect(form).toContain('countryCode: employeeStatutoryMy.passportIssuingCountryCode');
    expect(reports).toContain("oldIc: x?.oldIc ?? ''");
    expect(reports).toContain("countryCode: x?.countryCode ?? ''");
    // The two comments that said the columns do not exist are false now, and must not survive.
    const lib = fs.readFileSync(path.join(ROOT, 'lib/cp39-form.ts'), 'utf8');
    expect(lib).not.toContain('ALWAYS EMPTY');
    expect(lib).not.toContain('There is no old-IC column anywhere in');
    expect(reports).not.toContain('Blank because no column exists');
  });
});
