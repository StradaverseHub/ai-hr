/**
 * Custom Validation Messages for Leave Configuration (custom-messages migration).
 *
 * Each leave type carries an optional `customMessages` JSONB map of admin-authored override text, keyed by
 * the same camelCase field name as the rule's config column (currently only `backdatingLimitDays`). When a
 * validation rule fires and the corresponding key is set, requestLeave passes the admin string through the
 * typed error VERBATIM and the action-layer localizer (localizeLeaveError) renders it as-is instead of the
 * interpolated default. null/absent key ⇒ the built-in localized default (existing behaviour).
 *
 * This exercises the real backdating rule (the only rule that exists today) end-to-end at the service +
 * error layer, plus the updateLeaveType tri-state / validation / audit behaviour and the near-500-char
 * redirect/query-string round-trip. Mirrors test/leave-backdating.test.ts's harness helpers.
 *
 * Harness note (same as leave-backdating): the block path requires a NON-admin, employee-linked ctx whose
 * personId owns the employmentId it applies for — leave_request RLS is WITH CHECK app.can_see_employment,
 * so an unrelated ctx would fail the insert for a different reason and false-green the assertion.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestLeave, LeaveBackdatingNotAllowedError } from '../core/leave';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

/** Hire an employee (as admin) and return its OWN non-admin employee ctx + ids. */
async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'CustomMsg', primaryEmail: `cm_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

/** A unique leave-type code matching the leave_type_code_shape check (^[A-Z][A-Z0-9_]{1,31}$). */
function uniqCode(): string {
  return `CM_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

/** Insert a calendar-counted leave type with a (nullable) backdating limit + optional custom messages. */
async function leaveType(
  code: string,
  backdatingLimitDays: number | null,
  customMessages?: Record<string, string> | null,
): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      allowNegativeBalance: true, // 0ef0defd: test type opts out of the submit-time balance gate (test not about balance)
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      backdatingLimitDays,
      customMessages: customMessages ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** Shift an ISO yyyy-mm-dd by N days (negative = into the past). */
function shift(today: string, deltaDays: number): string {
  const ms = Date.parse(`${today}T00:00:00Z`) + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const TODAY = '2026-06-15';

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

describe('requestLeave — custom backdating message', () => {
  it('Scenario 1: a custom message wins — the typed error carries it verbatim', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const custom = 'Please pick Emergency Leave instead — this type cannot be applied so far back.';
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: custom });
    const start = shift(TODAY, -5); // over the limit ⇒ blocked
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveBackdatingNotAllowedError');
    } catch (e) {
      expect(e).toBeInstanceOf(LeaveBackdatingNotAllowedError);
      const err = e as LeaveBackdatingNotAllowedError;
      // The localizer returns `e.customMessage ?? default`, so this is exactly what the employee sees.
      expect(err.customMessage).toBe(custom);
      expect(err.message).toBe(custom);
    }
  });

  it('Scenario 2: no custom message ⇒ error carries none and falls back to the interpolated default', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), 3, null); // no customMessages
    const start = shift(TODAY, -5);
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveBackdatingNotAllowedError');
    } catch (e) {
      expect(e).toBeInstanceOf(LeaveBackdatingNotAllowedError);
      const err = e as LeaveBackdatingNotAllowedError;
      expect(err.customMessage).toBeUndefined();
      // The default interpolated message still carries the structured tokens for the localizer.
      expect(err.limitDays).toBe(3);
    }
  });

  it('an empty-string custom message for the rule key falls back to the default (treated as absent)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    // A raw empty string in the map — the pass-through uses `|| undefined`, so it must NOT become the message.
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: '' });
    const start = shift(TODAY, -5);
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveBackdatingNotAllowedError');
    } catch (e) {
      expect((e as LeaveBackdatingNotAllowedError).customMessage).toBeUndefined();
    }
  });

  it('near-500-char message round-trips through the redirect query-string path without corruption', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    // A 500-char message containing quotes, a colon and non-ASCII chars — all expand under encodeURIComponent.
    const prefix = 'Note: "cutoff" reached — ' + 'é'.repeat(10) + ' ';
    const custom = (prefix + 'x'.repeat(500 - prefix.length));
    expect(custom.length).toBe(500);
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: custom });
    const start = shift(TODAY, -5);
    let delivered = '';
    try {
      await requestLeave(ctx, { employmentId, leaveTypeId: ltId, startDate: start, endDate: start, today: TODAY });
      throw new Error('expected LeaveBackdatingNotAllowedError');
    } catch (e) {
      delivered = (e as LeaveBackdatingNotAllowedError).customMessage ?? '';
    }
    expect(delivered).toBe(custom);
    // Exercise the exact ?error= redirect transport used by /me and /leave actions: encode → decode.
    const roundTripped = decodeURIComponent(encodeURIComponent(delivered));
    expect(roundTripped).toBe(custom);
  });
});

describe('updateLeaveType — customMessages tri-state, validation & audit', () => {
  it('setting a custom message persists and is read back via the admin projection', async () => {
    const ltId = await leaveType(uniqCode(), 3, null);
    const custom = 'Kindly submit within 3 days.';
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'CM',
      backdatingLimitDays: 3,
      customMessages: { backdatingLimitDays: custom },
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect((t?.customMessages as Record<string, string> | null)?.backdatingLimitDays).toBe(custom);
  });

  it('a limit-only save (customMessages undefined) leaves the message untouched (independent tri-state)', async () => {
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: 'keep me' });
    // Touch ONLY the backdating limit via a payload with no customMessages key.
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'CM', backdatingLimitDays: 9 });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect(t?.backdatingLimitDays).toBe(9);
    expect((t?.customMessages as Record<string, string> | null)?.backdatingLimitDays).toBe('keep me');
  });

  it('a doc-only save leaves customMessages untouched', async () => {
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: 'keep me' });
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'CM', requiresDocument: true });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect((t?.customMessages as Record<string, string> | null)?.backdatingLimitDays).toBe('keep me');
  });

  it('clearing a message (blank) removes the key and round-trips to null', async () => {
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: 'to be cleared' });
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'CM',
      backdatingLimitDays: 3,
      customMessages: { backdatingLimitDays: '   ' }, // whitespace-only ⇒ treated as absent
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    // Last key removed ⇒ the whole column collapses to null, not an empty {} or a blank string.
    expect(t?.customMessages).toBeNull();
  });

  it('trims a stored message', async () => {
    const ltId = await leaveType(uniqCode(), 3, null);
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'CM',
      backdatingLimitDays: 3,
      customMessages: { backdatingLimitDays: '  padded  ' },
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect((t?.customMessages as Record<string, string> | null)?.backdatingLimitDays).toBe('padded');
  });

  it('rejects a message over 500 chars', async () => {
    const ltId = await leaveType(uniqCode(), 3, null);
    await expect(
      updateLeaveType(adminCtx(b), {
        id: ltId,
        name: 'CM',
        backdatingLimitDays: 3,
        customMessages: { backdatingLimitDays: 'x'.repeat(501) },
      }),
    ).rejects.toThrow(/500 characters/);
  });

  it('accepts a message at exactly 500 chars', async () => {
    const ltId = await leaveType(uniqCode(), 3, null);
    const msg = 'x'.repeat(500);
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'CM',
      backdatingLimitDays: 3,
      customMessages: { backdatingLimitDays: msg },
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const t = types.find((x) => x.id === ltId);
    expect((t?.customMessages as Record<string, string> | null)?.backdatingLimitDays).toBe(msg);
  });

  it('rejects an unknown rule key', async () => {
    const ltId = await leaveType(uniqCode(), 3, null);
    await expect(
      updateLeaveType(adminCtx(b), {
        id: ltId,
        name: 'CM',
        backdatingLimitDays: 3,
        customMessages: { someFutureRule: 'hello' },
      }),
    ).rejects.toThrow(/Unknown custom-message rule key/);
  });

  it('a customMessages-only save labels the change in its own audit block against the correct prior value', async () => {
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: 'old message' });
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'CM',
      customMessages: { backdatingLimitDays: 'new message' },
    });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    // The before-select fix means the prior value is real, not a silent undefined.
    expect((before.customMessages as Record<string, string> | null)?.backdatingLimitDays).toBe('old message');
    expect((after.customMessages as Record<string, string> | null)?.backdatingLimitDays).toBe('new message');
    // A message-only save must NOT falsely claim a backdatingLimitDays change.
    expect('backdatingLimitDays' in before).toBe(false);
  });

  it('a doc-only save does NOT claim a customMessages change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: 'keep me' });
    await updateLeaveType(adminCtx(b), { id: ltId, name: 'CM', requiresDocument: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown> | undefined;
    const after = payload?.after as Record<string, unknown> | undefined;
    expect('customMessages' in (before ?? {})).toBe(false);
    expect('customMessages' in (after ?? {})).toBe(false);
  });

  it('does not clobber other rule keys already stored (read-then-patch-then-write)', async () => {
    // Seed a second (future) rule key directly to prove the merge preserves keys not being edited.
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: 'bd msg', minAdvanceDays: 'future rule msg' });
    await updateLeaveType(adminCtx(b), {
      id: ltId,
      name: 'CM',
      customMessages: { backdatingLimitDays: 'updated bd msg' },
    });
    const types = await listLeaveTypes(adminCtx(b), { includeArchived: true });
    const cm = types.find((x) => x.id === ltId)?.customMessages as Record<string, string> | null;
    expect(cm?.backdatingLimitDays).toBe('updated bd msg');
    // The pre-existing, un-edited key must survive the patch.
    expect(cm?.minAdvanceDays).toBe('future rule msg');
  });
});

describe('migration — custom_messages applies cleanly to a fresh test DB', () => {
  it('the leave_type.custom_messages column exists and accepts a JSONB map', async () => {
    // A fresh migrateTestDb() ran in beforeAll; a round-trip insert/select proves the column is present and
    // typed (would throw "column does not exist" on a DB missing this migration).
    const ltId = await leaveType(uniqCode(), 3, { backdatingLimitDays: 'roundtrip' });
    const [row] = await owner.db
      .select({ cm: schema.leaveType.customMessages })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, ltId));
    expect((row?.cm as Record<string, string> | null)?.backdatingLimitDays).toBe('roundtrip');
  });
});
