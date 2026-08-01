/**
 * Feedback b9fd8fd5 — Age shows "Not Available" although the Date of Birth appears filled.
 *
 * Root cause: the Profile tab's DOB input is client-filled from the IC digits when person.date_of_birth is
 * NULL (components/ic-dob-autofill.tsx) — display-only, never persisted — while the Age beside it reads the
 * SAVED value. Employees whose IC arrived via bulk import (or pre-354a500d saves) had a filled-looking DOB
 * and a Not Available Age. Two fixes, both covered here:
 *
 *   1. Migration 0309 (data-only backfill): every person with NO saved DOB whose statutory row carries a
 *      valid 12-digit IC gets the derived date SAVED — the SQL derivation is pinned EQUIVALENT to the TS
 *      `dobFromIC` (century rule most-recent-non-future + rollover guard) over a vector set; unreal or
 *      short ICs are skipped (not failed); an existing DOB is never touched; the run is idempotent.
 *      Re-executes the UPDATE from the ACTUAL migration file (the 0298 convention in
 *      test/org-label-filtering.test.ts) so the test can never drift from what ships.
 *
 *   2. commitEmployeeImport now persists the derived DOB after setStatutoryProfileMY (dobOnlyIfEmpty via
 *      the audited setPersonComplianceFields — same path as setIcAction), so imports behave like manual
 *      entry and the phantom state cannot recur. A 12-digit IC whose YYMMDD is no real date still imports
 *      fine with the DOB left honestly blank.
 *
 *   3. Age renders post-backfill: completedYearsAt (the Profile tab's Age source) goes from null
 *      (Not Available) to the correct completed years once the backfilled DOB is saved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { commitEmployeeImport } from '../core/import';
import { completedYearsAt } from '../core/leave';
import { dobFromIC } from '../localization/my/ic-dob';
// The kernel judges these dates in MYT (bb4f2265); a fixture built in UTC disagrees with it
// between 00:00 and 08:00 MYT, which is a test that fails only at night.
import { todayInKualaLumpur } from '../lib/hr-date';

import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** Re-execute the 0309 backfill UPDATE from the ACTUAL migration file (equivalence-tested, not copied). */
async function runBackfill() {
  const migrationSql = fs.readFileSync(
    path.resolve(__dirname, '../db/migrations/0309_backfill_dob_from_ic.sql'),
    'utf8',
  );
  if (!migrationSql.includes('UPDATE "person"')) throw new Error('0309 backfill statement not found');
  await owner.db.execute(sql.raw(migrationSql));
}

/** Recreate the PRE-FIX world: a person with no saved DOB whose statutory row carries an IC (as bulk
 *  import / pre-354a500d saves left them). Direct owner writes — these rows predate the service guards. */
async function legacyPerson(ic: string | null, dob: string | null = null): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  const [p] = await owner.db
    .insert(schema.person)
    .values({
      tenantId: b.tenantId,
      fullName: `Legacy ${tag}`,
      primaryEmail: `legacy_${tag}@t.local`,
      dateOfBirth: dob,
    })
    .returning({ id: schema.person.id });
  await owner.db
    .insert(schema.employeeStatutoryMy)
    .values({ tenantId: b.tenantId, personId: p.id, icNumber: ic });
  return p.id;
}

async function dobOf(personId: string): Promise<string | null> {
  const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
  return (p.dateOfBirth as string | null) ?? null;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('b9fd8fd5 · migration 0309 — backfill person.date_of_birth from the saved IC', () => {
  // Valid vectors: [stored ic_number, expected saved DOB]. Chosen away from today's date so the
  // most-recent-non-future century rule is deterministic in SQL (CURRENT_DATE) and TS (new Date()) alike.
  const VALID: [string, string][] = [
    ['900101011234', '1990-01-01'], // the reporter's example — 2090 would be future → 1900s
    ['050101071234', '2005-01-01'], // small YY, 2000s reading not in the future
    ['880808-08-2345', '1988-08-08'], // punctuated legacy value — SQL normalises digits like normalizeIC
    ['400101011234', '1940-01-01'], // 2040 IS in the future → falls back to 1940
    ['260101011234', '2026-01-01'], // 2026 is not in the future → the 2000s reading wins
    ['000229011234', '2000-02-29'], // 29 Feb 2000 (leap), in the past
  ];
  // ICs the backfill must SKIP (row left NULL, migration never fails): unreal YYMMDD combos, a short
  // legacy value, and a passport-only row with no IC at all.
  const INVALID: (string | null)[] = [
    '991301011234', // month 13
    '900001011234', // day 00
    '900431011234', // 31 April
    '010229011234', // 29 Feb — neither 2001 nor 1901 is a leap year
    '12345', // short legacy garbage — not a 12-digit IC
    null, // non-Malaysian row: no IC to derive from
  ];

  it('saves the SAME date the screen derives (SQL ≡ dobFromIC over the vector set); unreal/short/missing ICs are skipped', async () => {
    const valid = await Promise.all(VALID.map(([ic]) => legacyPerson(ic)));
    const invalid = await Promise.all(INVALID.map((ic) => legacyPerson(ic)));

    await runBackfill();

    for (let i = 0; i < VALID.length; i++) {
      const [ic, expected] = VALID[i];
      const saved = await dobOf(valid[i]);
      expect(saved, `IC ${ic}`).toBe(expected);
      // Equivalence pin: the migration writes EXACTLY what ic-dob-autofill has been showing on screen.
      expect(saved, `IC ${ic} (TS parity)`).toBe(dobFromIC(ic));
    }
    for (let i = 0; i < INVALID.length; i++) {
      const ic = INVALID[i];
      expect(await dobOf(invalid[i]), `IC ${String(ic)}`).toBeNull();
      // TS parity for the skipped ones too: the screen derives nothing either — no phantom fill remains.
      if (ic !== null) expect(dobFromIC(ic)).toBeNull();
    }
  });

  it('NEVER touches an existing DOB — a hand-entered date survives even when the IC derives a different one', async () => {
    const keeper = await legacyPerson('911111013456', '1985-05-05'); // IC derives 1991-11-11
    await runBackfill();
    expect(await dobOf(keeper)).toBe('1985-05-05');
  });

  it('is idempotent — a second run changes nothing', async () => {
    const ids = [
      await legacyPerson('900101011234'),
      await legacyPerson('991301011234'),
      await legacyPerson('911111013456', '1985-05-05'),
    ];
    await runBackfill();
    const first = await Promise.all(ids.map(dobOf));
    await runBackfill();
    expect(await Promise.all(ids.map(dobOf))).toEqual(first);
    expect(first).toEqual(['1990-01-01', null, '1985-05-05']);
  });

  it('the Age the Profile tab computes goes from Not Available (null) to the correct completed years', async () => {
    const p = await legacyPerson('900101011234');
    const today = todayInKualaLumpur();
    // Pre-fix world: saved DOB is NULL → completedYearsAt (the page's Age source) yields null → Not Available.
    expect(completedYearsAt(await dobOf(p), today)).toBeNull();

    await runBackfill();

    const age = completedYearsAt(await dobOf(p), today);
    expect(age).not.toBeNull();
    expect(age).toBe(completedYearsAt('1990-01-01', today)); // 36 as of 2026 (before 1 Jan 2027)
  });
});

describe('b9fd8fd5 · CSV employee import persists the derived DOB (imports behave like manual entry)', () => {
  const rec = (over: Record<string, string>): Record<string, string> => ({
    full_name: '',
    email: '',
    department: 'Finance',
    hired_on: '2026-06-01',
    ic_number: '',
    basic_salary: '5000',
    ...over,
  });

  async function personByEmail(email: string): Promise<string> {
    const [p] = await owner.db
      .select({ id: schema.person.id })
      .from(schema.person)
      .where(eq(schema.person.primaryEmail, email));
    return p.id;
  }

  it('a valid imported IC also saves the derived DOB via the audited dobOnlyIfEmpty path', async () => {
    const result = await commitEmployeeImport(adminCtx(b), {
      companyId: b.companyId,
      records: [rec({ full_name: 'Import Dob', email: 'importdob@acme.test', ic_number: '920202024321' })],
    });
    expect(result.imported).toBe(1);
    expect(result.failed).toHaveLength(0);

    const personId = await personByEmail('importdob@acme.test');
    expect(await dobOf(personId)).toBe('1992-02-02');
    // Same provenance as setIcAction's safety net: an audited person.updated through setPersonComplianceFields.
    const payload = await latestEventPayload(b.tenantId, personId, 'person.updated');
    expect(payload).toMatchObject({
      via: 'admin-set',
      fields: expect.arrayContaining(['dateOfBirth']),
      after: { dateOfBirth: '1992-02-02' },
    });
  });

  it('a 12-digit IC whose YYMMDD is no real date imports fine and leaves the DOB honestly blank', async () => {
    const result = await commitEmployeeImport(adminCtx(b), {
      companyId: b.companyId,
      records: [rec({ full_name: 'No Real Date', email: 'norealdate@acme.test', ic_number: '991301015678' })],
    });
    expect(result.imported).toBe(1); // the guard skips the DOB, it never fails the row
    expect(result.failed).toHaveLength(0);

    const personId = await personByEmail('norealdate@acme.test');
    expect(await dobOf(personId)).toBeNull();
    expect(await latestEventPayload(b.tenantId, personId, 'person.updated')).toBeNull();
  });
});
