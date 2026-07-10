/**
 * Leave Type Visual Configuration Enhancement (feedback 639fdf77).
 *
 * Two additive, nullable, DISPLAY-ONLY columns on leave_type (migration 0179): `color` (7-token allow-list)
 * + `icon` (curated icon-registry key). HR sets them in the Leave Config → Leave Type panel's new "Leave Type
 * Visual Configuration" sub-form; they surface only on the employee My Profile → Leave tab (icon beside the
 * name + colour chip on the row). NEVER read for entitlement / eligibility / workflow / calculation.
 *
 * Coverage: resolver fallback (stored → code-keyed → default) + hasColor; migration columns round-trip;
 * updateLeaveType persists color+icon and reads back via the admin projection; out-of-allow-list color +
 * unknown icon are rejected; tri-state isolation (a visual-only save leaves a sibling column untouched, and
 * an unrelated save leaves color/icon untouched); the audit event carries the before/after visual diff (and
 * an unrelated save does NOT claim a visual change); leaveBalances threads color/icon/code onto each row
 * without altering the ledger math; and the i18n `visual` block exists in all 6 locales.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { listLeaveTypes, leaveBalances } from '../core/read';
import { leaveVisual, LEAVE_COLOR_TOKENS, LEAVE_ICON_KEYS } from '../lib/leave-visual';
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

async function hireEmployeeCtx(): Promise<{ ctx: SessionContext; employmentId: string }> {
  const { employmentId, personId } = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Visual', primaryEmail: `vis_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  return { ctx: { tenantId: b.tenantId, userId, roles: ['employee'], personId }, employmentId };
}

function uniqCode(): string {
  return `VIS_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

async function leaveType(code: string, patch?: { color?: string | null; icon?: string | null } | null): Promise<string> {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code,
      name: code,
      paid: true,
      counting: 'calendar_days',
      color: patch?.color ?? null,
      icon: patch?.icon ?? null,
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

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

describe('leaveVisual resolver — fallback stored → code-keyed → default', () => {
  it('a stored icon + colour wins', () => {
    const v = leaveVisual({ color: 'teal', icon: 'plane', code: 'ANNUAL' });
    expect(v.iconKey).toBe('plane');
    expect(v.hasColor).toBe(true);
    expect(v.chipClass).not.toBe('');
    expect(typeof v.Icon).toBe('object'); // a Lucide forwardRef component
  });

  it('no stored icon ⇒ code-keyed default (SICK ⇒ thermometer)', () => {
    const v = leaveVisual({ color: null, icon: null, code: 'SICK' });
    expect(v.iconKey).toBe('thermometer');
  });

  it('no stored icon + unknown code ⇒ universal default (calendardays)', () => {
    const v = leaveVisual({ color: null, icon: null, code: 'SOMETHING_NEW' });
    expect(v.iconKey).toBe('calendardays');
  });

  it('no colour configured ⇒ hasColor false + empty chip (system default styling)', () => {
    const v = leaveVisual({ color: null, icon: 'palmtree', code: 'ANNUAL' });
    expect(v.hasColor).toBe(false);
    expect(v.chipClass).toBe('');
  });

  it('an out-of-list stored colour/icon is ignored (defensive read never throws)', () => {
    const v = leaveVisual({ color: 'chartreuse', icon: 'no-such-icon', code: 'MATERNITY' });
    expect(v.hasColor).toBe(false); // junk colour ⇒ no chip
    expect(v.iconKey).toBe('baby'); // junk icon ⇒ code-keyed default
  });
});

describe('migration 0179 — color + icon columns', () => {
  it('exist and round-trip on a fresh test DB', async () => {
    const ltId = await leaveType(uniqCode(), { color: 'purple', icon: 'graduationcap' });
    const [row] = await owner.db
      .select({ color: schema.leaveType.color, icon: schema.leaveType.icon })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, ltId));
    expect(row?.color).toBe('purple');
    expect(row?.icon).toBe('graduationcap');
  });

  it('the token allow-lists are non-empty (registry sanity)', () => {
    expect(LEAVE_COLOR_TOKENS).toContain('blue');
    expect(LEAVE_COLOR_TOKENS).toHaveLength(7);
    expect(LEAVE_ICON_KEYS.length).toBeGreaterThanOrEqual(15);
  });
});

describe('updateLeaveType — visual persistence, validation, tri-state & audit', () => {
  it('persists color + icon and reads back via the admin projection', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), color: 'red', icon: 'heart' });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.color).toBe('red');
    expect(t?.icon).toBe('heart');
  });

  it('rejects an out-of-allow-list colour', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await expect(
      updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), color: 'magenta', icon: 'heart' }),
    ).rejects.toThrow(/Unknown leave colour theme/);
  });

  it('rejects an unknown icon key', async () => {
    const ltId = await leaveType(uniqCode(), null);
    await expect(
      updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), color: 'red', icon: 'rocketship' }),
    ).rejects.toThrow(/Unknown leave icon/);
  });

  it('an empty string clears the columns (⇒ null / default styling)', async () => {
    const ltId = await leaveType(uniqCode(), { color: 'blue', icon: 'palmtree' });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), color: '', icon: '' });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.color).toBeNull();
    expect(t?.icon).toBeNull();
  });

  it('a visual-only save leaves a sibling column (backdatingLimitDays) untouched', async () => {
    const [row] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: uniqCode(), name: 'X', paid: true, counting: 'calendar_days', backdatingLimitDays: 5 })
      .returning({ id: schema.leaveType.id });
    await updateLeaveType(adminCtx(b), { id: row.id, name: 'X', color: 'green', icon: 'baby' });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === row.id);
    expect(t?.backdatingLimitDays).toBe(5); // sibling survived
    expect(t?.color).toBe('green');
    expect(t?.icon).toBe('baby');
  });

  it('an unrelated save (doc-only) leaves color/icon untouched', async () => {
    const ltId = await leaveType(uniqCode(), { color: 'orange', icon: 'cake' });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), requiresDocument: true });
    const t = (await listLeaveTypes(adminCtx(b), { includeArchived: true })).find((x) => x.id === ltId);
    expect(t?.color).toBe('orange'); // survived a save with no visual marker
    expect(t?.icon).toBe('cake');
  });

  it('records the visual change in the audit event (before/after diff)', async () => {
    const ltId = await leaveType(uniqCode(), { color: 'blue', icon: 'palmtree' });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), color: 'teal', icon: 'plane' });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown>;
    const after = payload?.after as Record<string, unknown>;
    expect(before.color).toBe('blue');
    expect(before.icon).toBe('palmtree');
    expect(after.color).toBe('teal');
    expect(after.icon).toBe('plane');
  });

  it('a doc-only save does NOT claim a visual change in the audit event', async () => {
    const ltId = await leaveType(uniqCode(), { color: 'red', icon: 'heart' });
    await updateLeaveType(adminCtx(b), { id: ltId, name: uniqCode(), requiresDocument: true });
    const payload = await latestEventPayload(b.tenantId, ltId, 'leave-type.updated');
    const before = payload?.before as Record<string, unknown> | undefined;
    const after = payload?.after as Record<string, unknown> | undefined;
    expect('color' in (before ?? {})).toBe(false);
    expect('icon' in (after ?? {})).toBe(false);
  });
});

describe('read layer — leaveBalances threads color/icon/code without touching math', () => {
  it('a configured type surfaces its color + icon + code on the balance row', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const code = uniqCode();
    const ltId = await leaveType(code, { color: 'purple', icon: 'graduationcap' });
    const rows = await leaveBalances(ctx, employmentId);
    const row = rows.find((r) => r.leaveTypeId === ltId);
    expect(row).toBeDefined();
    expect(row?.color).toBe('purple');
    expect(row?.icon).toBe('graduationcap');
    expect(row?.code).toBe(code);
    // Ledger math for a fresh, activity-free type is unchanged (all zero).
    expect(row?.balance).toBe(0);
    expect(row?.available).toBe(0);
  });

  it('an unconfigured type surfaces null color/icon (default styling downstream)', async () => {
    const { ctx, employmentId } = await hireEmployeeCtx();
    const ltId = await leaveType(uniqCode(), null);
    const rows = await leaveBalances(ctx, employmentId);
    const row = rows.find((r) => r.leaveTypeId === ltId);
    expect(row?.color).toBeNull();
    expect(row?.icon).toBeNull();
    // The resolver then falls back to the default icon (no colour chip) for such a row.
    const v = leaveVisual({ color: row?.color, icon: row?.icon, code: row?.code });
    expect(v.hasColor).toBe(false);
  });
});

describe('i18n — visual block present in all 6 locales', () => {
  const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;
  for (const loc of LOCALES) {
    it(`${loc}.json admin.leave.visual has all keys incl. 7 colour names`, () => {
      const j = JSON.parse(readFileSync(join(process.cwd(), 'messages', `${loc}.json`), 'utf8'));
      const v = j.admin?.leave?.visual;
      expect(v, `${loc} admin.leave.visual`).toBeTruthy();
      for (const k of ['sectionTitle', 'help', 'iconLabel', 'colorLabel', 'searchPlaceholder', 'noIcons']) {
        expect(typeof v[k], `${loc} visual.${k}`).toBe('string');
      }
      for (const token of LEAVE_COLOR_TOKENS) {
        expect(typeof v.color?.[token], `${loc} visual.color.${token}`).toBe('string');
      }
    });
  }
});
