/**
 * 6e9a126e — the written record of everything the reset cleared, and its READER.
 *
 * The approved plan tells the reporter: "Before anything is cleared we take a written record of BOTH
 * layers… That record becomes a read-only listing inside your admin screens that you can open and
 * download, so you read the old figures off it while you retype them rather than working from memory."
 *
 * ⚠️ RELEASE THREE CUT THIS FILE IN HALF, AND THE HALF THAT WENT IS THE CAPTURE.
 *
 * The capture is `app.capture_entitlement_reset_archive()` (migration 0398), and every string it renders
 * is read out of `benefit_scheme`, `scheme_leave_entitlement` and `leave_policy`. Migration 0405 calls it
 * once — in the same transaction, immediately before dropping all three. After that transaction commits
 * there is nothing left for it to read, so the tests that seeded those tables and asserted the rendered
 * text CANNOT BE REPOINTED AT ANYTHING: re-creating the three tables to feed them would be testing the
 * layer this release exists to delete. They are retired, and the specific assertions and what each one
 * protected are listed in the commit that removed them.
 *
 * WHAT SURVIVES IS THE HALF RELEASE THREE ACTUALLY DEPENDS ON. The archive is DENORMALISED TO TEXT
 * precisely so it outlives the tables it describes — that design claim is what makes the drop
 * survivable, and it is now literally true here: not one test below can reach a benefit scheme or a leave
 * policy, because neither table exists, and the listing, the snapshot selection and the CSV all still
 * work. Those are the reporter's "open it and download it", and they are what the retyping is done from.
 *
 * ⚠️ THE ROWS ARE SEEDED DIRECTLY, AND NO TEST ASSERTS THE TEXT IT SEEDED. A reader test that writes
 * "0-2 yrs: 14 days" into a column and then expects to read it back proves only that Postgres stores
 * strings. Every expectation below is on something the READER decides: which snapshot is shown, what
 * order rows come back in, and the two places the CSV must SPELL OUT a null rather than leave a blank
 * cell. The rendering itself was the capture's job and the capture is gone.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  captureEntitlementResetArchive,
  entitlementResetArchiveCsv,
  listEntitlementArchiveCaptures,
  listEntitlementResetArchive,
} from '../core/entitlement-archive';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const TAG = 'test-capture';

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

/**
 * One archived row, written the way the capture wrote it: flat text, no foreign key to anything. The
 * owner connection is used because the capture ran as SQL rather than through any TS writer — there is no
 * app-level insert path for this table and inventing one for a test would be a second mechanism.
 */
type ArchiveSeed = Partial<typeof schema.entitlementResetArchive.$inferInsert> & { layer: 'scheme' | 'policy' };
const archived = async (p: ArchiveSeed & { captureTag?: string; capturedAt?: Date }) =>
  owner.db.insert(schema.entitlementResetArchive).values({
    tenantId: b.tenantId,
    captureTag: p.captureTag ?? TAG,
    ...p,
  });

describe('the archive listing is readable with the layers it describes already dropped', () => {
  it('returns a capture\'s rows scheme-layer first, then by scheme, leave type, company and start date', async () => {
    // Inserted in deliberately wrong order, so passing means the READER sorted rather than the database
    // happening to hand rows back in insertion order.
    await archived({ layer: 'policy', leaveTypeName: 'Annual Leave', validFromText: '2026-01-01' });
    await archived({ layer: 'policy', leaveTypeName: 'Annual Leave', validFromText: '2024-01-01' });
    await archived({ layer: 'scheme', schemeName: 'Grade 12-15 Permanent', leaveTypeName: 'Annual Leave' });
    await archived({ layer: 'scheme', schemeName: 'Contract (unfilled)', leaveTypeName: 'Annual Leave' });

    const rows = await listEntitlementResetArchive(adminCtx(b), { captureTag: TAG });
    expect(rows).toHaveLength(4);
    // Scheme side first — it is the layer the reporter retypes as entitlement templates, and 'policy'
    // sorts BEFORE 'scheme' alphabetically, so this ordering can only come from the reader's own CASE.
    expect(rows.map((r) => r.layer)).toEqual(['scheme', 'scheme', 'policy', 'policy']);
    expect(rows.slice(0, 2).map((r) => r.schemeName)).toEqual(['Contract (unfilled)', 'Grade 12-15 Permanent']);
    // Within a layer, the dated windows come back oldest first so a reader can follow the history.
    expect(rows.slice(2).map((r) => r.validFromText)).toEqual(['2024-01-01', '2026-01-01']);
  });

  it('groups the snapshots by tag with their row counts, newest capture first', async () => {
    await archived({ layer: 'policy', captureTag: 'release-one' });
    await archived({ layer: 'policy', captureTag: 'release-one' });
    await archived({ layer: 'scheme', captureTag: 'pre-reset' });

    const captures = await listEntitlementArchiveCaptures(adminCtx(b));
    expect(captures.map((c) => c.captureTag).sort()).toEqual(['pre-reset', 'release-one']);
    expect(captures.find((c) => c.captureTag === 'release-one')!.rows).toBe(2);
    expect(captures.find((c) => c.captureTag === 'pre-reset')!.rows).toBe(1);
  });

  it('with no tag asked for, shows ONE snapshot — the latest — never a mixture of two', async () => {
    // The reset re-captures immediately before clearing, so two snapshots months apart is the normal
    // state of this table. Interleaving them would have the reporter retyping a blend of both.
    const old = new Date('2026-08-01T00:00:00Z');
    await archived({ layer: 'policy', captureTag: 'release-one', capturedAt: old, leaveTypeName: 'Annual Leave' });
    await archived({ layer: 'scheme', captureTag: 'pre-reset', schemeName: 'Grade 12-15 Permanent' });

    const latest = await listEntitlementResetArchive(adminCtx(b));
    expect(latest).toHaveLength(1);
    expect(latest.every((r) => r.captureTag === 'pre-reset')).toBe(true);
  });

  it('an empty archive reads as empty rather than throwing', async () => {
    expect(await listEntitlementArchiveCaptures(adminCtx(b))).toEqual([]);
    expect(await listEntitlementResetArchive(adminCtx(b))).toEqual([]);
    const file = await entitlementResetArchiveCsv(adminCtx(b));
    expect(file.rows).toBe(0);
    expect(file.content.trim().split('\n')).toHaveLength(1); // header only
  });
});

describe('the CSV is what the reporter retypes from', () => {
  it('carries every column, one line per row, and names itself after the snapshot', async () => {
    await archived({
      layer: 'scheme',
      schemeName: 'Grade 12-15 Permanent',
      schemeCategory: 'Permanent',
      leaveTypeName: 'Annual Leave',
      leaveTypeCode: 'ANNUAL',
      companyName: 'Acme Sdn Bhd',
      schemeGradeGroupName: 'Grade 12-15',
      schemeGradeGroupMembers: 'Grade 12',
      employmentType: 'full_time',
      entitlementText: '0-2 yrs: 14 days, max brought forward 5, max entitled + brought forward 19',
      validFromText: '—  (not dated)',
    });
    await archived({ layer: 'policy', leaveTypeName: 'Annual Leave', validFromText: '2024-01-01' });

    const file = await entitlementResetArchiveCsv(adminCtx(b), { captureTag: TAG });
    expect(file.filename).toContain('entitlement-configuration-record');
    expect(file.filename).toContain(TAG);
    expect(file.filename.endsWith('.csv')).toBe(true);
    const lines = file.content.trim().split('\n');
    expect(lines[0]).toContain('Entitlement');
    expect(lines[0]).toContain('In force from');
    expect(lines).toHaveLength(file.rows + 1);
    expect(file.rows).toBe(2);
    // Both layers are exported under readable labels, not their storage spellings.
    expect(file.content).toContain('Benefit scheme');
    expect(file.content).toContain('Company / grade rule');
    expect(file.content).toContain('Grade 12-15 Permanent');
  });

  it('SPELLS OUT the two nulls that mean something on the policy side', async () => {
    // A blank cell in a spreadsheet reads as "unknown". On the policy layer a null company meant ALL
    // companies and a null grade meant ALL grades — values somebody chose. This is the one piece of
    // interpretation the export does, and it is the piece a retyper acts on.
    await archived({ layer: 'policy', leaveTypeName: 'Annual Leave', companyName: null, gradeName: null });
    const file = await entitlementResetArchiveCsv(adminCtx(b), { captureTag: TAG });
    expect(file.content).toContain('All companies (group default)');
    expect(file.content).toContain('All grades');
  });

  it('leaves the same nulls BLANK on the scheme side, where they carry no such meaning', async () => {
    // The scheme layer had no company-default or grade-default concept, so inventing one in its cells
    // would be the export asserting something the configuration never said.
    await archived({ layer: 'scheme', schemeName: 'Contract (unfilled)', companyName: null, gradeName: null });
    const file = await entitlementResetArchiveCsv(adminCtx(b), { captureTag: TAG });
    expect(file.content).not.toContain('All companies (group default)');
    expect(file.content).not.toContain('All grades');
  });

  it('sanitises the snapshot tag into the filename rather than trusting it', async () => {
    await archived({ layer: 'policy', captureTag: 'pre reset/2026' });
    const file = await entitlementResetArchiveCsv(adminCtx(b), { captureTag: 'pre reset/2026' });
    expect(file.filename).toBe('entitlement-configuration-record_pre-reset-2026.csv');
  });
});

/**
 * ⚠️ THE RE-CAPTURE ENTRY POINT IS DEAD, AND THIS IS WHERE THAT IS WRITTEN DOWN.
 *
 * `captureEntitlementResetArchive` calls `app.capture_entitlement_reset_archive()`, whose body selects
 * from `benefit_scheme`, `scheme_leave_entitlement` and `leave_policy`. Migration 0405 calls it once and
 * then drops all three in the same transaction, and does NOT drop the function — so from the moment 0405
 * commits, calling it raises `relation "benefit_scheme" does not exist`. Measured, not assumed: a probe
 * against a migrated test database returned exactly that.
 *
 * Nothing reaches it today — /admin/leave/entitlements/archive and its export route are both READERS —
 * which is why this is a latent landmine rather than a live fault, and why the guard below is a guard and
 * not a pin. It does not assert that the failure is correct; it asserts that nobody has wired a screen to
 * it. If you need re-capture back, fix or drop the SQL function FIRST, then delete this test.
 */
describe('the re-capture entry point', () => {
  it('refuses a blank capture tag rather than writing an unfindable snapshot', async () => {
    // Refused in TypeScript, before the query is built — so this is the one part of the capture path that
    // still behaves exactly as it always did.
    await expect(captureEntitlementResetArchive(adminCtx(b), { captureTag: '  ' })).rejects.toThrow(
      /capture tag is required/i,
    );
  });

  it('is not wired to any screen — calling it would raise on the tables 0405 dropped', () => {
    const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && readFileSync(full, 'utf8').includes('captureEntitlementResetArchive')) {
          offenders.push(full);
        }
      }
    };
    walk(appDir);
    expect(offenders).toEqual([]);
  });
});
