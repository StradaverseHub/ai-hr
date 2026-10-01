/**
 * 2a57a007 (r340) — EMERGENCY LEAVE STOPS PRINTING ANNUAL LEAVE'S ENTITLEMENT.
 *
 * The reporter's screenshot, verbatim:
 *
 *     AL  *Annual Leave      Entitlement 7.00   Earned to Date 2.50   Balance 3.00
 *     EL  Emergency Leave    Entitlement 7.00   Earned to Date 2.50   Balance 0.00
 *         Entitlement table: GP1215_P
 *
 * A row cannot hold seven days of entitlement and no balance at the same time, and the false half is the
 * entitlement: Emergency Leave has none of its own — it spends the Annual pool. It was showing Annual's
 * figures because `balanceStoryTypeId` points a borrower's whole breakdown at the POOL, which is right for
 * the balance story and wrong for the two columns that are statements about this leave type.
 *
 * ⚠️ THE TRAP THIS FILE EXISTS TO KEEP SHUT (r209). An earlier version DID point a borrower at its own
 * breakdown, and because such a type has no entitlement table the screen printed a RED "create an
 * entitlement table for it" notice — the single instruction that would END the borrowing the arrangement
 * exists for. So the suppression below is asserted BOTH WAYS: silent for a pooled borrower, and still loud
 * for an unpooled type with no table, in the same file, so the suppression cannot widen unnoticed.
 *
 * ⚠️ AND THE r338 HALF MUST NOT REGRESS. test/2a57a007-el-shared-pool-display.test.ts pins the positive
 * Share columns, the zeroed Taken/Pending, the badges and the export's source columns. Nothing here loosens
 * any of it; `available` and the submit guard are re-asserted here too, because this item's whole risk is a
 * display change reaching a right to apply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { openLeaveYear, requestLeave, InsufficientLeaveBalanceOnSubmitError } from '../core/leave';
import { createEligibilityRule, createEntitlementTemplate } from '../core/entitlement-template';
import { leaveBalances } from '../core/read';
import { ENTITLEMENT_STATUS_LABEL_KEY, entitlementStatusNeedsNotice } from '../lib/entitlement-status';
import { employeeBalanceRows, type EmployeeBalanceRow } from '../app/leave/employee-balances/rows';
import { pooledEntitlementCaption } from '../lib/shared-leave-balance';

import en from '../messages/en.json';
import ms from '../messages/ms.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import zh from '../messages/zh.json';

const CATALOGUES = { en, ms, ta, th, vi, zh } as const;
type Locale = keyof typeof CATALOGUES;
const LOCALES = Object.keys(CATALOGUES) as Locale[];

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(root + rel, 'utf8');

const AS_OF = '2026-12-31';
let b: Base;

const uniq = (p: string) => `${p} ${randomUUID().slice(0, 6)}`;

async function leaveTypeRow(opts: { name?: string; code?: string; balanceSourceTypeId?: string } = {}) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({
      tenantId: b.tenantId,
      code: opts.code ?? `P${randomUUID().slice(0, 6).toUpperCase()}`,
      name: opts.name ?? uniq('Pool Leave'),
      paid: true,
      counting: 'calendar_days',
      ...(opts.balanceSourceTypeId ? { balanceSourceTypeId: opts.balanceSourceTypeId } : {}),
    })
    .returning({ id: schema.leaveType.id });
  return row.id;
}

/** A NAMED entitlement table reaching everybody — the thing the borrower must stop claiming as its own. */
async function table(leaveTypeId: string, days: number, name: string) {
  const tpl = await createEntitlementTemplate(adminCtx(b), {
    leaveTypeId,
    name,
    serviceBands: [{ fromYears: 0, toYears: null, days }],
    validFrom: '2026-01-01',
  });
  await createEligibilityRule(adminCtx(b), {
    name: `${name} — eligibility`,
    templateLineageId: tpl.lineageId,
    criteria: {} as never,
    validFrom: '2026-01-01',
  });
  return tpl;
}

const hire = () =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Pooled', primaryEmail: `pool_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });

/**
 * THE REPORTER'S SHAPE, with a REAL entitlement table on the pool. A fixture that granted the ledger
 * directly would leave the pool's own Entitlement at 0.00 and its table name null — and then the borrower
 * printing the pool's figures would be indistinguishable from the borrower printing its own zeros, which is
 * precisely the confusion this item is about. The table is what makes the old behaviour visible.
 */
const POOL_TABLE = 'Executive Annual Leave';
const POOL_DAYS = 7;

async function elPool() {
  const pool = await leaveTypeRow({ name: uniq('Pool Annual'), code: `AL${randomUUID().slice(0, 4).toUpperCase()}` });
  const el = await leaveTypeRow({
    name: uniq('Pool Emergency'),
    code: `EL${randomUUID().slice(0, 4).toUpperCase()}`,
    balanceSourceTypeId: pool,
  });
  await table(pool, POOL_DAYS, POOL_TABLE);
  const { employmentId } = await hire();
  await openLeaveYear(adminCtx(b), { year: 2026 });
  return { pool, el, employmentId };
}

const screenRows = async (employmentId: string) => {
  const rows = await employeeBalanceRows(adminCtx(b), employmentId, AS_OF, 'en');
  return new Map(rows.map((r) => [r.leaveTypeId, r]));
};

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

describe('2a57a007 (r340) · (a) the borrower states its OWN entitlement, which is nothing', () => {
  it('Entitlement and Earned to Date read 0.00 on a pooled borrower while the pool keeps its figures', async () => {
    const { pool, el, employmentId } = await elPool();
    const screen = await screenRows(employmentId);

    const poolRow = screen.get(pool)!;
    expect(poolRow.fullEntitlement, 'the pool must really hold days, or this test proves nothing').toBe(POOL_DAYS);
    expect(poolRow.ytdEntitled, 'and must really have earned some of them').toBe(POOL_DAYS);

    const borrower = screen.get(el)!;
    expect(borrower.fullEntitlement, 'Emergency Leave has no entitlement of its own').toBe(0);
    expect(borrower.ytdEntitled, 'and earns nothing of its own').toBe(0);
    expect(borrower.balance, 'beside the 0.00 balance that was already true').toBe(0);
  });

  it('the borrower names the POOL and does NOT name an entitlement table', async () => {
    const { pool, el, employmentId } = await elPool();
    const screen = await screenRows(employmentId);

    const poolRow = screen.get(pool)!;
    const borrower = screen.get(el)!;
    expect(poolRow.entitlementTemplateName, 'the table belongs to the pool, and stays on its row').toBe(POOL_TABLE);
    expect(borrower.entitlementTemplateName, 'naming the pool’s table on the borrower claimed a table it has not got').toBeNull();
    expect(borrower.entitlementFromPool, 'it says where the days come from instead').toBe(poolRow.leaveType);
    expect(poolRow.entitlementFromPool, 'the pool does not borrow from itself').toBeNull();
  });

  it('the caption for a borrower is the pooled sentence, shared by the screen and the export', async () => {
    const { el, employmentId } = await elPool();
    const borrower = (await screenRows(employmentId)).get(el)!;
    const c = pooledEntitlementCaption(borrower);
    expect(c, 'a borrower has something to say about its own entitlement').not.toBeNull();
    expect(c!.labelKey, 'one sentence, one key, both surfaces').toBe('statusPooledEntitlement');
    expect(c!.tipKey, 'and one hover explanation').toBe('statusPooledEntitlementTip');
    expect(c!.pool, 'and it names the pool').toBe(borrower.entitlementFromPool);
  });
});

describe('2a57a007 (r340) · (b) the r209 GUARD — the suppression must not widen', () => {
  it('an UNPOOLED type with no entitlement table still gets the red diagnostic', async () => {
    const orphan = await leaveTypeRow({ name: uniq('Unpooled Study') });
    const { employmentId } = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const row = (await screenRows(employmentId)).get(orphan)!;
    expect(row.entitlementFromPool, 'it borrows from nothing').toBeNull();
    expect(
      pooledEntitlementCaption(row),
      'the pooled caption must NOT claim this row — its missing table IS the defect r209 raises',
    ).toBeNull();
    expect(row.entitlementStatus, 'so it keeps the state r209 exists to raise').toBe('no_entitlement_table');
    expect(ENTITLEMENT_STATUS_LABEL_KEY[row.entitlementStatus]).toBe('statusNoEntitlementTable');
    expect(entitlementStatusNeedsNotice(row.entitlementStatus), 'and it is still said out loud, in amber').toBe(true);
  });

  /**
   * THE SHAPE THAT MAKES THE EXPORT'S COLUMN DANGEROUS, AND IT WAS NOT COVERED UNTIL THIS CASE.
   *
   * A borrower inherits the POOL's entitlement STATUS (`balanceStoryTypeId`), so while the pool has a real
   * table the borrower resolves `granted` and the status column reads "Generated" — harmless. The borrower
   * only reaches `no_entitlement_table` when THE POOL ITSELF has none, and that is the state whose sentence
   * is the r209 instruction: "No entitlement table … Create an entitlement table for it", printed on the row
   * of a type that must never have one. Production can reach it in one click (archive the pool's table, or
   * point a borrower at a type nobody has configured yet), so it is asserted here rather than reasoned about.
   */
  it('a borrower whose POOL has no table inherits “no entitlement table” — and STILL says it draws on the pool', async () => {
    const pool = await leaveTypeRow({ name: uniq('Unconfigured Pool') });
    const el = await leaveTypeRow({ name: uniq('Pool Emergency'), balanceSourceTypeId: pool });
    const { employmentId } = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });
    const screen = await screenRows(employmentId);

    const borrower = screen.get(el)!;
    const poolRow = screen.get(pool)!;
    // The RAW state, unchanged — this item suppressed no status and moved no diagnostic.
    expect(borrower.entitlementStatus, 'the borrower still tells the POOL’s entitlement story').toBe('no_entitlement_table');
    expect(borrower.entitlementStatus).toBe(poolRow.entitlementStatus);
    expect(
      ENTITLEMENT_STATUS_LABEL_KEY[borrower.entitlementStatus],
      'so the raw status map WOULD have printed the r209 instruction on this row',
    ).toBe('statusNoEntitlementTable');
    expect(entitlementStatusNeedsNotice(borrower.entitlementStatus), 'and in amber').toBe(true);
    // …and the pooled caption outranks it, on the screen and in the export both, because on THIS row the
    // absence of a table is correct. The POOL's own row keeps the diagnostic: its missing table IS a defect.
    const c = pooledEntitlementCaption(borrower);
    expect(c, 'the borrower says where its days come from instead').not.toBeNull();
    expect(c!.pool).toBe(poolRow.leaveType);
    expect(pooledEntitlementCaption(poolRow), 'the pool is not borrowing, so it is still told to fix itself').toBeNull();
    // And the two columns this item is about are the borrower's own on this shape too.
    expect(borrower.fullEntitlement).toBe(0);
    expect(borrower.ytdEntitled).toBe(0);
    expect(borrower.entitlementTemplateName).toBeNull();
  });

  it('an ordinary unpooled type WITH a table is untouched in every entitlement column', async () => {
    const medical = await leaveTypeRow({ name: uniq('Unpooled Medical') });
    await table(medical, 14, 'Standard Medical Leave');
    const { employmentId } = await hire();
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const row = (await screenRows(employmentId)).get(medical)!;
    expect(row.fullEntitlement, 'its own band, exactly as before').toBe(14);
    expect(row.ytdEntitled).toBe(14);
    expect(row.entitlementTemplateName, 'its own table, exactly as before').toBe('Standard Medical Leave');
    expect(row.entitlementFromPool).toBeNull();
    expect(row.sharedBalance, 'and no pool descriptor at all').toBeNull();
    expect(pooledEntitlementCaption(row), 'and no pooled caption').toBeNull();
    expect(row.entitlementStatus).toBe('granted');
    expect(entitlementStatusNeedsNotice(row.entitlementStatus), 'a generated figure needed no caption before, and still does not').toBe(false);
  });
});

describe('2a57a007 (r340) · (c) the three surfaces read ONE decision', () => {
  it('the screen and the export take the caption from the same function, not from the status map', () => {
    const page = read('app/leave/employee-balances/page.tsx');
    const route = read('app/leave/employee-balances/export/route.ts');
    for (const [name, src] of [['page', page], ['export route', route]] as const) {
      expect(src, `${name} must read the ONE pooled decision, not re-derive it`).toContain('pooledEntitlementCaption(r)');
      expect(src, `${name} must not test for a pool by hand`).not.toContain('r.entitlementFromPool != null');
      // Every OTHER row is untouched: both surfaces still resolve the shared status map exactly as 31e39d74
      // and r266 pin them. A pooled branch that replaced that map would have moved fifteen other states.
      expect(src, `${name} must still read the shared status map for every other row`).toContain(
        'ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]',
      );
    }
    // r378 wraps the same caption and exact note in the compact inquiry tooltip.
    const start = page.indexOf('const entitlementCaptionCell =');
    const split = page.indexOf('if (!entitlementStatusNeedsNotice', start);
    const end = page.indexOf('const params =', split);
    expect(start).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(split);
    const pooled = page.slice(start, split);
    expect(pooled, 'the pooled caption is MUTED — nothing here is wrong').toContain('className="inline text-muted-foreground"');
    expect(pooled).toContain('data-testid="entitlement-pooled-caption"');
    expect(pooled).toContain('<InquiryNote');
    expect(pooled).toContain('pooled.labelKey');
    expect(pooled).toContain('pooled.tipKey');
    expect(pooled).not.toMatch(/text-amber|text-destructive/);
    const notice = page.slice(split, end);
    expect(notice, 'amber remains reserved for a real misconfiguration').toContain('className="inline text-amber-700 dark:text-amber-500"');
    expect(notice).toContain('ENTITLEMENT_STATUS_LABEL_KEY[r.entitlementStatus]');
    expect(notice).toContain('ENTITLEMENT_STATUS_TIP_KEY[r.entitlementStatus]');
  });

  /**
   * ⚠️ WHAT THIS CASE PINS AND WHAT IT DOES NOT. Its fixture gives the POOL a real table, so the borrower
   * resolves `granted` and the raw status map would have printed "Generated" on this row — harmless, and
   * asserted below so the fixture cannot be misread as the dangerous one. The dangerous shape (a pool with
   * NO table, where the raw map prints the r209 instruction) is §(b)'s third case, and the EXPORT'S OWN
   * CELLS are exercised — route invoked, CSV parsed — in test/2a57a007-borrower-export-cells.test.ts.
   */
  it('the borrower’s status sentence is the pooled one, and it never mentions an entitlement table', async () => {
    const { el, pool, employmentId } = await elPool();
    const screen = await screenRows(employmentId);
    // `statusNotConfigured` and `statusNoEntitlementTable` are THE SAME English sentence, which is why the
    // export could not be left on the raw map: whichever of the two a borrower row resolved to, the file HR
    // forwards said "No entitlement table" about a type that must never have one.
    const bal = en.me.leaveBalanceTable as unknown as Record<string, string>;
    expect(bal.statusNotConfigured, 'the collision that makes this column dangerous').toBe(bal.statusNoEntitlementTable);
    const c = pooledEntitlementCaption(screen.get(el)!)!;
    expect(bal[c.labelKey], 'the borrower’s cell').not.toContain('entitlement table');
    expect(bal[c.labelKey]!.replace('{pool}', screen.get(pool)!.leaveType)).toContain(screen.get(pool)!.leaveType);
    expect(
      bal[ENTITLEMENT_STATUS_LABEL_KEY[screen.get(el)!.entitlementStatus]],
      'the sentence the raw status map would have printed on this row instead',
    ).toBe(bal.statusGenerated);
  });
});

describe('2a57a007 (r340) · (d) NOTHING about the days or the right to apply moved', () => {
  it('available is still the pool’s on both rows, and the submit guard still refuses an over-spend', async () => {
    const { pool, el, employmentId } = await elPool();
    const core = new Map((await leaveBalances(adminCtx(b), employmentId, 'en', { includeHidden: true, asOf: AS_OF })).map((r) => [r.leaveTypeId, r]));
    expect(core.get(el)!.available, 'zeroing this would make Emergency Leave unapplyable for everyone').toBe(POOL_DAYS);
    expect(core.get(pool)!.available, 'and the pool sees the same figure').toBe(POOL_DAYS);
    expect(core.get(pool)!.balance, 'the pool’s ledger balance is untouched by any display decision').toBe(POOL_DAYS);

    await expect(
      requestLeave(adminCtx(b), {
        employmentId,
        leaveTypeId: el,
        startDate: '2026-06-01',
        endDate: '2026-06-30',
        today: '2026-05-01',
      }),
      'a 30-day Emergency request against a 7-day pool must still be refused',
    ).rejects.toThrow(InsufficientLeaveBalanceOnSubmitError);
  });

  it('the borrower can still be applied for and still spends the pool', async () => {
    const { pool, el, employmentId } = await elPool();
    await requestLeave(adminCtx(b), { employmentId, leaveTypeId: el, startDate: '2026-06-01', endDate: '2026-06-01', today: '2026-05-01' });
    const screen = await screenRows(employmentId);
    expect(screen.get(el)!.pendingShare, 'the r338 half is untouched: the day is reported under Pending Share').toBe(1);
    expect(screen.get(pool)!.pendingShare, 'and the pool shows what it has lent out').toBe(1);
    expect(screen.get(el)!.fullEntitlement, 'and the borrower still claims no entitlement of its own').toBe(0);
  });
});

/**
 * i18n/request.ts DEEP-MERGES each locale over English, so a key missing from ms.json renders the English
 * sentence rather than MISSING_MESSAGE. Presence has to be asserted explicitly, and so does the fact that
 * the six are SIX — a copy of the English string into all six files would pass a presence check.
 */
describe('2a57a007 (r340) · six locales, present and distinct', () => {
  const KEYS = ['statusPooledEntitlement', 'statusPooledEntitlementTip'] as const;
  const balTable = (loc: Locale) =>
    (CATALOGUES[loc] as unknown as { me: { leaveBalanceTable: Record<string, unknown> } }).me.leaveBalanceTable;

  it.each(LOCALES)('%s carries every new key', (loc) => {
    for (const k of KEYS) expect(typeof balTable(loc)[k], `me.leaveBalanceTable.${k} missing in ${loc}`).toBe('string');
  });

  it.each([...KEYS])('me.leaveBalanceTable.%s is translated, not copied', (k) => {
    const all = LOCALES.map((l) => String(balTable(l)[k]));
    expect(new Set(all).size, `${k} is identical across locales — it was copied, not translated`).toBe(LOCALES.length);
  });

  it('every locale interpolates the pool name the screen passes it', () => {
    for (const loc of LOCALES) {
      for (const k of KEYS) {
        expect(String(balTable(loc)[k]).includes('{pool}'), `${loc}: ${k} drops the {pool} the caller passes`).toBe(true);
      }
    }
  });

  it('the pooled sentence never tells HR to create an entitlement table', () => {
    const tip = String(balTable('en').statusPooledEntitlementTip);
    expect(tip, 'r209: the tip must say the absence is correct').toContain('does not need one');
    expect(/create an entitlement table for it/i.test(tip), 'the one instruction that would stop the borrowing').toBe(false);
  });
});

/** A type guard rather than a comment: the row type must carry the pool name to both surfaces. */
/**
 * 2a57a007 (r340) — THE EXPLAIN PANEL'S TWO NEW STRINGS. The panel is the plan's THIRD surface; the sentences
 * are RENDERED, in all six locales, in test/2a57a007-borrower-explain-panel.dom.test.tsx. This block pins the
 * catalogue half: present, translated rather than copied, and interpolating the name the caller passes.
 *
 * `leave.breakdown.explain.pooledOwnEntitlement` names `{source}` and not `{pool}` on purpose — it is the
 * argument name its sibling `poolFigures` already uses, and the one r303's catalogue guard has a value for.
 */
describe('2a57a007 (r340) · the Explain panel’s pooled statement, in six locales', () => {
  const brk = (loc: Locale) =>
    (CATALOGUES[loc] as unknown as { leave: { breakdown: Record<string, unknown> } }).leave.breakdown;
  const explain = (loc: Locale) => brk(loc).explain as Record<string, string>;

  it.each(LOCALES)('%s carries both keys', (loc) => {
    expect(typeof brk(loc).pooledOwnEntitlement, `leave.breakdown.pooledOwnEntitlement missing in ${loc}`).toBe('string');
    expect(typeof explain(loc).pooledOwnEntitlement, `explain.pooledOwnEntitlement missing in ${loc}`).toBe('string');
  });

  it('both are translated, not copied', () => {
    const banners = LOCALES.map((l) => String(brk(l).pooledOwnEntitlement));
    const lines = LOCALES.map((l) => explain(l).pooledOwnEntitlement);
    expect(new Set(banners).size, 'the panel statement is identical across locales — it was copied').toBe(LOCALES.length);
    expect(new Set(lines).size, 'the per-line sentence is identical across locales — it was copied').toBe(LOCALES.length);
  });

  it('every locale interpolates the pool the caller passes, under the name its caller uses', () => {
    for (const loc of LOCALES) {
      expect(String(brk(loc).pooledOwnEntitlement).includes('{pool}'), `${loc}: the panel statement drops {pool}`).toBe(true);
      expect(explain(loc).pooledOwnEntitlement.includes('{source}'), `${loc}: the per-line sentence drops {source}`).toBe(true);
    }
  });

  it('neither sentence tells HR to create an entitlement table', () => {
    for (const loc of LOCALES) {
      for (const msg of [String(brk(loc).pooledOwnEntitlement), explain(loc).pooledOwnEntitlement]) {
        expect(/create an entitlement table/i.test(msg), `${loc}: r209’s wrong instruction`).toBe(false);
      }
    }
  });
});

describe('2a57a007 (r340) · the row carries the fact', () => {
  it('EmployeeBalanceRow declares entitlementFromPool', () => {
    const src = read('app/leave/employee-balances/rows.ts');
    expect(src).toContain('entitlementFromPool: string | null;');
    const typed: keyof EmployeeBalanceRow = 'entitlementFromPool';
    expect(typed).toBe('entitlementFromPool');
  });

  /**
   * THE THIRD SURFACE'S WIRING, AS A FACT ABOUT THE ROW RATHER THAN AS A GREP. The panel cannot derive
   * "this row borrows" for itself: for a borrower it is handed the POOL's breakdown, so from inside the panel
   * the borrower's row and the pool's own row are identical. The row builder is the only place that knows.
   */
  it('the row hands the Explain panel the same pool fact its own cells were built from', async () => {
    const { pool, el, employmentId } = await elPool();
    const screen = await screenRows(employmentId);

    const borrower = screen.get(el)!;
    expect(borrower.breakdown!.leaveTypeId, 'the panel is still fed the POOL’s breakdown (r209)').toBe(pool);
    expect(
      borrower.hrExplanation.entitlementFromPool,
      'and is told whose it is, so it cannot print the pool’s Entitlement under a row reading 0.00',
    ).toBe(borrower.entitlementFromPool);
    expect(screen.get(pool)!.hrExplanation.entitlementFromPool, 'the pool’s own panel is unchanged').toBeNull();
  });
});
