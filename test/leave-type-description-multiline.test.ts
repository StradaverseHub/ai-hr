/**
 * Description Field Multiline (feedback fbcadc71) — the Leave Type Description control was a single-line
 * <input>; pressing Enter submitted the form instead of adding a line break. The fix is a front-end swap to
 * <textarea>. This test guards the persistence contract the UI relies on: the create/update service path
 * .trim()s only the leading/trailing whitespace, so internal newlines are stored and read back byte-for-byte.
 * If a future refactor ever collapses newlines (e.g. a normalize/replace) this test fails and warns that the
 * multiline textarea would silently lose line breaks.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createLeaveType, updateLeaveType } from '../core/admin';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

function uniqCode(): string {
  return `ML_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, '')}`;
}

async function descOf(id: string): Promise<string | null> {
  const [row] = await owner.db
    .select({ description: schema.leaveType.description })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row?.description ?? null;
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

describe('leave type description — multiline preservation (fbcadc71)', () => {
  const MULTILINE = 'Line one\nLine two\n\nParagraph after blank line';

  it('createLeaveType stores internal newlines verbatim (only ends trimmed)', async () => {
    const ctx = adminCtx(b);
    // Simulate the textarea value with surrounding whitespace the service .trim()s off.
    const { id } = await createLeaveType(ctx, {
      code: uniqCode(),
      name: `Multiline ${randomUUID().slice(0, 8)}`,
      description: `  ${MULTILINE}  `,
    });
    expect(await descOf(id)).toBe(MULTILINE);
  });

  it('updateLeaveType round-trips newlines on rename/edit', async () => {
    const ctx = adminCtx(b);
    const name = `Edit me ${randomUUID().slice(0, 8)}`;
    const { id } = await createLeaveType(ctx, {
      code: uniqCode(),
      name,
      description: 'single line',
    });
    await updateLeaveType(ctx, { id, name, description: MULTILINE });
    expect(await descOf(id)).toBe(MULTILINE);
  });
});
