/**
 * Item 354a500d — auto-populate Date of Birth from a Malaysian MyKad IC number.
 *
 * Two layers:
 *  A) the PURE derivation `dobFromIC` (localization/my/ic-dob.ts, re-exported from statutory.ts):
 *     YYMMDD → most-recent-non-future calendar date, or null on a bad/short IC or an unreal date.
 *  B) the SERVER SAFETY NET on `setPersonComplianceFields({ dobOnlyIfEmpty })`: derives + persists the DOB
 *     ONLY when the person has none (fires the audited person.updated event), and NEVER overwrites an
 *     existing DOB. Also pins that a manual DOB change still emits person.updated (audit trail intact).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setPersonComplianceFields } from '../core/profile';
import { dobFromIC } from '../localization/my/statutory';
import { dobFromIC as dobFromICLeaf } from '../localization/my/ic-dob';
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

// A fixed "now" so the century rule (most-recent-non-future) is deterministic in tests.
const NOW = new Date('2026-07-15T00:00:00Z');

describe('354a500d · dobFromIC (pure derivation)', () => {
  it('re-export from statutory.ts is the same implementation as the leaf module', () => {
    expect(dobFromIC).toBe(dobFromICLeaf);
  });

  it('derives 01 Jan 1990 from 900101… (2090 would be in the future → 1900s)', () => {
    expect(dobFromIC('900101011234', NOW)).toBe('1990-01-01');
  });

  it('derives 01 Jan 2005 from a small YY (05) — 2005 is not in the future', () => {
    expect(dobFromIC('050101071234', NOW)).toBe('2005-01-01');
  });

  it('accepts a formatted IC with dashes/spaces (normalises first)', () => {
    expect(dobFromIC('900101-01-1234', NOW)).toBe('1990-01-01');
    expect(dobFromIC('900101 01 1234', NOW)).toBe('1990-01-01');
  });

  it('returns null when the first six digits are not a real date (month 13)', () => {
    expect(dobFromIC('991301011234', NOW)).toBeNull();
  });

  it('returns null for day 00 and 31 April (unreal calendar dates)', () => {
    expect(dobFromIC('900001011234', NOW)).toBeNull(); // day 00
    expect(dobFromIC('900431011234', NOW)).toBeNull(); // 31 April
  });

  it('returns null when the IC is not 12 digits', () => {
    expect(dobFromIC('', NOW)).toBeNull();
    expect(dobFromIC('90010101123', NOW)).toBeNull(); // 11 digits
    expect(dobFromIC('9001010112345', NOW)).toBeNull(); // 13 digits
    expect(dobFromIC('abcd0101abcd', NOW)).toBeNull();
  });

  it('honours the most-recent-non-future century boundary', () => {
    // YY = 26 with our NOW in 2026: 2026-01-01 is NOT in the future → the 2000s reading wins.
    expect(dobFromIC('260101011234', NOW)).toBe('2026-01-01');
    // YY = 40: 2040-01-01 IS in the future → fall back to 1940-01-01.
    expect(dobFromIC('400101011234', NOW)).toBe('1940-01-01');
  });

  it('handles the 29 Feb leap-year edge (2000 is leap; 2001 is not)', () => {
    expect(dobFromIC('000229011234', NOW)).toBe('2000-02-29'); // 2000 leap, in the past
    expect(dobFromIC('010229011234', NOW)).toBeNull(); // neither 2001 nor 1901 has 29 Feb
  });
});

let b: Base;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}

async function dobOf(personId: string): Promise<string | null> {
  const [p] = await owner.db.select().from(schema.person).where(eq(schema.person.id, personId));
  return (p.dateOfBirth as string | null) ?? null;
}

async function eventCount(tenantId: string, personId: string): Promise<number> {
  const rows = await owner.db
    .select()
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.aggregateId, personId));
  return rows.filter((r) => r.eventType === 'person.updated').length;
}

describe('354a500d · server-side DOB autofill (setPersonComplianceFields dobOnlyIfEmpty)', () => {
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

  it('fills an EMPTY DOB from a derived IC value and fires an audited person.updated', async () => {
    const E = await hire('EmptyDob');
    const derived = dobFromIC('900101011234'); // 1990-01-01
    expect(derived).toBe('1990-01-01');

    await setPersonComplianceFields(adminCtx(b), {
      employmentId: E.employmentId,
      dateOfBirth: derived!,
      dobOnlyIfEmpty: true,
    });

    expect(await dobOf(E.personId)).toBe('1990-01-01');
    const payload = await latestEventPayload(b.tenantId, E.personId, 'person.updated');
    expect(payload).toMatchObject({
      via: 'admin-set',
      fields: expect.arrayContaining(['dateOfBirth']),
      after: { dateOfBirth: '1990-01-01' },
    });
  });

  it('NEVER overwrites an existing DOB (dobOnlyIfEmpty is a no-op, no extra event)', async () => {
    const E = await hire('KeepDob');
    // A manually set DOB first (normal path — this DOES emit person.updated).
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, dateOfBirth: '1985-05-05' });
    expect(await dobOf(E.personId)).toBe('1985-05-05');
    const eventsBefore = await eventCount(b.tenantId, E.personId);

    // Now the IC-autofill path tries a DIFFERENT derived DOB — it must be ignored.
    await setPersonComplianceFields(adminCtx(b), {
      employmentId: E.employmentId,
      dateOfBirth: '1990-01-01',
      dobOnlyIfEmpty: true,
    });

    expect(await dobOf(E.personId)).toBe('1985-05-05'); // unchanged
    expect(await eventCount(b.tenantId, E.personId)).toBe(eventsBefore); // no-op → no new audit event
  });

  it('a manual DOB change still emits person.updated (audit trail intact)', async () => {
    const E = await hire('ManualDob');
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, dateOfBirth: '1990-01-01' });
    const first = await eventCount(b.tenantId, E.personId);
    expect(first).toBeGreaterThanOrEqual(1);

    // Admin corrects it by hand (no dobOnlyIfEmpty) — overwrite allowed + audited.
    await setPersonComplianceFields(adminCtx(b), { employmentId: E.employmentId, dateOfBirth: '1991-02-02' });
    expect(await dobOf(E.personId)).toBe('1991-02-02');
    const payload = await latestEventPayload(b.tenantId, E.personId, 'person.updated');
    expect(payload).toMatchObject({
      via: 'admin-set',
      before: { dateOfBirth: '1990-01-01' },
      after: { dateOfBirth: '1991-02-02' },
    });
    expect(await eventCount(b.tenantId, E.personId)).toBe(first + 1);
  });
});
