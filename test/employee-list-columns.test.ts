/**
 * Personnel listing — customizable columns, headcount cards and the shared query parse (feedback
 * 579255c3, points 1, 2, 3, 5, 6, 9 and 10).
 *
 * FOUR THINGS ARE PINNED HERE, and the first two are the ones that would ship silently broken:
 *
 *  1. THE EXTRA COLUMNS DO NOT MULTIPLY ROWS. Every opt-in column but one is a 1:1 lookup, but
 *     "Reporting To" reads reporting_line, which is 0..N per employment. A join there returns one list
 *     row PER EDGE — the same employee twice, the pager total wrong, and a green suite either way. This
 *     file gives one employee TWO reporting edges and asserts the list still holds exactly one of them.
 *     (The Companies screen rendered 1 of 8 rows for 24 days behind a green suite; this is the same class
 *     of fault in the other direction.)
 *
 *  2. THE CARDS AGREE WITH THE ROWS. The five headcount figures are a separate query from the list, so
 *     the only thing stopping them drifting apart is that both are built from one WHERE. Asserted by
 *     counting through the cards and then narrowing to the same bucket and counting the rows.
 *
 *  3. A SAVED COLUMN PREFERENCE CAN NEVER PRODUCE AN EMPTY TABLE — a legacy value, a removed column or a
 *     tampered payload all normalise back to something renderable, and Full Name cannot be switched off.
 *
 *  4. THE EXPORT AND THE SCREEN READ ONE QUERY STRING. parsePersonnelListQuery is the single parse both
 *     use, so "the export respects the selected filters" is true by construction rather than by care.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { countEmployeesByStatus, listEmployeesPage } from '../core/read';
import {
  getEmployeeListColumns,
  resetEmployeeListColumns,
  setEmployeeListColumns,
} from '../core/employee-list-prefs';
import {
  DEFAULT_EMPLOYEE_COLUMNS,
  EMPLOYEE_COLUMN_KEYS,
  UNAVAILABLE_EMPLOYEE_FIELDS,
  columnsFromParam,
  employeeColumnText,
  normalizeEmployeeColumns,
} from '../lib/employee-columns';
import {
  draftMatchesQuery,
  headcountFilters,
  parsePersonnelListQuery,
} from '../app/admin/personnel/list-query';

let b: Base;
beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

const hire = (fullName: string, extra: Partial<Parameters<typeof hireEmployee>[1]> = {}) =>
  hireEmployee(adminCtx(b), {
    person: { fullName, primaryEmail: `col_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    positionId: b.positionId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
    ...extra,
  });

const page = (p: Parameters<typeof listEmployeesPage>[1]) => listEmployeesPage(adminCtx(b), p);

// ── 1. the opt-in columns come back, and none of them widens the result ──────────────────────────────

describe('579255c3 — the opt-in columns are read from information Personnel already holds', () => {
  it('returns job grade, business unit, cost centre, work location, employment type, join date and the reporting manager', async () => {
    const [grade] = await owner.db
      .insert(schema.jobGrade)
      .values({ tenantId: b.tenantId, code: 'G17', name: 'GRADE 17 (PERMANENT)', rank: 17 })
      .returning({ id: schema.jobGrade.id });
    const [bu] = await owner.db
      .insert(schema.businessUnit)
      .values({ tenantId: b.tenantId, companyId: b.companyId, code: 'BU1', name: 'Construction' })
      .returning({ id: schema.businessUnit.id });
    const [loc] = await owner.db
      .insert(schema.location)
      .values({ tenantId: b.tenantId, companyId: b.companyId, code: 'HQ', name: 'Kuala Lumpur HQ' })
      .returning({ id: schema.location.id });

    const manager = await hire('Column Manager');
    const carrier = await hire('Column Carrier', {
      gradeId: grade.id,
      costCenterId: b.costCenterId,
      reportingManagerEmploymentId: manager.employmentId,
    });
    // Business unit and work location live on the CURRENT assignment; hireEmployee does not take them.
    await owner.db
      .update(schema.assignment)
      .set({ businessUnitId: bu.id, locationId: loc.id })
      .where(
        and(
          eq(schema.assignment.employmentId, carrier.employmentId),
          isNull(schema.assignment.validTo),
          isNull(schema.assignment.supersededAt),
        ),
      );
    await owner.db
      .update(schema.employment)
      .set({ joinDate: '2024-03-01' })
      .where(eq(schema.employment.id, carrier.employmentId));

    const { rows } = await page({ limit: 200, offset: 0 });
    const row = rows.find((r) => r.employmentId === carrier.employmentId);
    expect(row).toBeDefined();
    expect(row!.jobGrade).toBe('GRADE 17 (PERMANENT)');
    expect(row!.businessUnit).toBe('Construction');
    expect(row!.costCenter).toBe('HQ');
    expect(row!.workLocation).toBe('Kuala Lumpur HQ');
    expect(row!.employmentType).toBe('full_time');
    expect(row!.joinDate).toBe('2024-03-01');
    expect(row!.reportingTo).toBe('Column Manager');
    // Position was ALREADY selected before this item and simply never printed — the plan's claim, pinned.
    expect(row!.position).toBe('Executive');
    // An employee with none of them reads null, not a crash and not another employee's value.
    const bare = rows.find((r) => r.employmentId === manager.employmentId);
    expect(bare!.jobGrade).toBeNull();
    expect(bare!.businessUnit).toBeNull();
    expect(bare!.reportingTo).toBeNull();
  });

  it('a SECOND reporting edge does not duplicate the row or inflate the pager total', async () => {
    const alt = await hire('Column Second Manager');
    const [subject] = await owner.db
      .select({ id: schema.employment.id })
      .from(schema.employment)
      .innerJoin(schema.person, eq(schema.person.id, schema.employment.personId))
      .where(eq(schema.person.fullName, 'Column Carrier'));

    const before = await page({ limit: 500, offset: 0 });
    // A functional line ALONGSIDE the administrative one — a perfectly ordinary state, and the one that
    // would turn a join into a duplicated employee.
    await owner.db.insert(schema.reportingLine).values({
      tenantId: b.tenantId,
      subordinateEmploymentId: subject.id,
      managerEmploymentId: alt.employmentId,
      lineType: 'functional',
      validFrom: '2024-01-01',
    });

    const after = await page({ limit: 500, offset: 0 });
    expect(after.rows.filter((r) => r.employmentId === subject.id)).toHaveLength(1);
    // Nothing was HIRED between the two reads — only an edge added — so the pager total must not move.
    expect(after.total).toBe(before.total);
    expect(after.rows.length).toBe(after.total);
    // The ADMINISTRATIVE edge is still the one shown — the same manager the profile shows.
    expect(after.rows.find((r) => r.employmentId === subject.id)!.reportingTo).toBe('Column Manager');
  });
});

// ── 2. the headcount cards ───────────────────────────────────────────────────────────────────────────

describe('579255c3 — the headcount cards are counted over the whole filtered set', () => {
  it('totals to the sum of its buckets, and every bucket matches the rows it narrows to', async () => {
    const leaver = await hire('Column Leaver');
    await owner.db
      .update(schema.employment)
      .set({ resignationDate: '2020-01-01' })
      .where(eq(schema.employment.id, leaver.employmentId));

    const cards = await countEmployeesByStatus(adminCtx(b), {});
    const summed = Object.values(cards.byStatus).reduce((a, n) => a + n, 0);
    expect(summed).toBe(cards.total);
    expect(cards.byStatus.resigned).toBeGreaterThanOrEqual(1);

    // THE PROPERTY THAT MATTERS: clicking a card and counting the rows gives the number ON the card.
    for (const [bucket, n] of Object.entries(cards.byStatus)) {
      const narrowed = await page({
        employmentStatuses: [bucket as 'active'],
        limit: 500,
        offset: 0,
      });
      expect(narrowed.total, `${bucket} card vs rows`).toBe(n);
    }
    // …and the unnarrowed total is the pager total.
    const all = await page({ limit: 500, offset: 0 });
    expect(cards.total).toBe(all.total);
  });

  it('follows the other filters, so the cards describe the view rather than the database', async () => {
    const scoped = await countEmployeesByStatus(adminCtx(b), { companyId: randomUUID() });
    expect(scoped.total).toBe(0);
    expect(Object.keys(scoped.byStatus)).toHaveLength(0);

    const real = await countEmployeesByStatus(adminCtx(b), { companyId: b.companyId });
    expect(real.total).toBeGreaterThan(0);
    // A search narrows the cards exactly as it narrows the rows.
    const searched = await countEmployeesByStatus(adminCtx(b), { q: 'Column Carrier' });
    const searchedRows = await page({ q: 'Column Carrier', limit: 500, offset: 0 });
    expect(searched.total).toBe(searchedRows.total);
  });
});

// ── 3. the saved column preference ───────────────────────────────────────────────────────────────────

describe('579255c3 — a per-user column preference, through the own-row seam', () => {
  it('starts at the default view, round-trips a chosen set and order, and resets', async () => {
    const ctx = adminCtx(b);
    expect((await getEmployeeListColumns(ctx)).selected).toEqual([...DEFAULT_EMPLOYEE_COLUMNS]);

    await setEmployeeListColumns(ctx, {
      selected: ['code', 'name', 'jobGrade', 'status'],
      order: ['code', 'name', 'jobGrade', 'status', 'company', 'department', 'position'],
    });
    const saved = await getEmployeeListColumns(ctx);
    expect(saved.selected).toEqual(['code', 'name', 'jobGrade', 'status']);
    // Every catalogue key survives in the order, exactly once, saved ones first.
    expect(new Set(saved.order)).toEqual(new Set(EMPLOYEE_COLUMN_KEYS));
    expect(saved.order).toHaveLength(EMPLOYEE_COLUMN_KEYS.length);
    expect(saved.order.slice(0, 4)).toEqual(['code', 'name', 'jobGrade', 'status']);

    await resetEmployeeListColumns(ctx);
    expect((await getEmployeeListColumns(ctx)).selected).toEqual([...DEFAULT_EMPLOYEE_COLUMNS]);
  });

  it('refuses to store a preference that would leave the table with no columns', async () => {
    const ctx = adminCtx(b);
    await setEmployeeListColumns(ctx, { selected: ['not_a_column', 42], order: 'nonsense' });
    const saved = await getEmployeeListColumns(ctx);
    expect(saved.selected).toEqual([...DEFAULT_EMPLOYEE_COLUMNS]);
    await resetEmployeeListColumns(ctx);
  });

  it('does not disturb another screen\'s preference in the same envelope', async () => {
    const ctx = adminCtx(b);
    // A foreign key in the shared envelope, written directly — the state a second list screen would
    // create. Setting and resetting THIS screen's columns must leave it alone.
    await owner.db.execute(
      sql`update app_user set list_preferences = '{"someOtherList":{"keep":true}}'::jsonb where id = ${b.adminUserId}`,
    );
    await setEmployeeListColumns(ctx, { selected: ['code', 'name'], order: ['code', 'name'] });
    await resetEmployeeListColumns(ctx);
    const [row] = await owner.db
      .select({ prefs: schema.appUser.listPreferences })
      .from(schema.appUser)
      .where(eq(schema.appUser.id, b.adminUserId));
    expect(row.prefs).toEqual({ someOtherList: { keep: true } });
  });
});

// ── 4. the pure pieces: catalogue, projection, query parse ───────────────────────────────────────────

describe('579255c3 — the column catalogue normalises anything into something renderable', () => {
  it('defaults to the reporter\'s six columns in their order', () => {
    expect(normalizeEmployeeColumns(null).selected).toEqual([
      'code',
      'name',
      'company',
      'department',
      'position',
      'status',
    ]);
    // "Hired" comes OFF the default view but stays in the catalogue as an optional column.
    expect(normalizeEmployeeColumns(null).selected).not.toContain('groupJoinDate');
    expect(EMPLOYEE_COLUMN_KEYS).toContain('groupJoinDate');
  });

  it('keeps Full Name whatever the caller asks, and re-sorts the selection into the order', () => {
    const forced = normalizeEmployeeColumns({ selected: ['code'], order: [...EMPLOYEE_COLUMN_KEYS] });
    expect(forced.selected).toContain('name');
    const resorted = normalizeEmployeeColumns({
      selected: ['status', 'code', 'name'],
      order: ['code', 'name', 'status'],
    });
    expect(resorted.selected).toEqual(['code', 'name', 'status']);
  });

  it('appends a column added in a later release rather than dropping the saved order', () => {
    const legacy = normalizeEmployeeColumns({ selected: ['code', 'name'], order: ['name', 'code'] });
    expect(legacy.order.slice(0, 2)).toEqual(['name', 'code']);
    expect(new Set(legacy.order)).toEqual(new Set(EMPLOYEE_COLUMN_KEYS));
  });

  it('the export takes the screen\'s explicit list, falling back to the saved one', () => {
    expect(columnsFromParam('code,jobGrade,name', null)).toEqual(['code', 'jobGrade', 'name']);
    // Unknown keys are dropped, not rendered as empty columns.
    expect(columnsFromParam('code,made_up,name', null)).toEqual(['code', 'name']);
    // Nothing usable in the param ⇒ the saved preference decides.
    expect(columnsFromParam('', { selected: ['code', 'name'], order: ['code', 'name'] })).toEqual([
      'code',
      'name',
    ]);
    expect(columnsFromParam(null, null)).toEqual([...DEFAULT_EMPLOYEE_COLUMNS]);
  });

  it('projects every catalogue column to text, so the file and the screen cannot disagree', () => {
    const row = {
      employeeCode: 'X00002',
      name: 'Jess Ting',
      email: 'jess@t.local',
      company: 'XYZ BINA SDN BHD',
      department: 'Finance',
      position: 'Assistant Sales Manager',
      jobGrade: 'GRADE 17 (PERMANENT)',
      reportingTo: 'Column Manager',
      businessUnit: 'Construction',
      costCenter: 'HQ',
      workLocation: 'Kuala Lumpur HQ',
      hiredOn: '2025-05-01',
      joinDate: '2025-06-01',
      confirmationDate: null,
    };
    const resolved = { status: 'Active', employmentType: 'Full-time' };
    // Every key has an answer — a column added to the catalogue without a projection would be undefined.
    for (const key of EMPLOYEE_COLUMN_KEYS) {
      expect(employeeColumnText(row, key, resolved), key).not.toBeUndefined();
    }
    expect(employeeColumnText(row, 'code', resolved)).toBe('X00002');
    expect(employeeColumnText(row, 'status', resolved)).toBe('Active');
    expect(employeeColumnText(row, 'employmentType', resolved)).toBe('Full-time');
    expect(employeeColumnText(row, 'groupJoinDate', resolved)).toBe('2025-05-01');
    expect(employeeColumnText(row, 'joinDate', resolved)).toBe('2025-06-01');
    expect(employeeColumnText(row, 'confirmationDate', resolved)).toBeNull();
  });

  it('names the eight fields that do not exist rather than omitting them silently', () => {
    expect([...UNAVAILABLE_EMPLOYEE_FIELDS]).toEqual([
      'division',
      'section',
      'line',
      'team',
      'region',
      'base',
      'employeeCategory',
      'employeeType',
    ]);
    // …and none of them is a column, because there is no employee information behind it.
    for (const f of UNAVAILABLE_EMPLOYEE_FIELDS) {
      expect(EMPLOYEE_COLUMN_KEYS as readonly string[]).not.toContain(f);
    }
    // Job Grade is NOT one of them — employment.grade_id is real.
    expect(EMPLOYEE_COLUMN_KEYS).toContain('jobGrade');
  });
});

describe('579255c3 — one parse of the query string, for the screen and the export alike', () => {
  it('reads the derived bucket without touching the legacy lifecycle param', () => {
    const derived = parsePersonnelListQuery({ bucket: 'probation' });
    expect(derived.filters.employmentStatuses).toEqual(['probation']);
    expect(derived.filters.status).toBeUndefined();

    const legacy = parsePersonnelListQuery({ status: 'terminated' });
    expect(legacy.filters.status).toBe('terminated');
    expect(legacy.filters.employmentStatuses).toBeUndefined();

    // A bucket nobody can be in is ignored rather than narrowing to nothing.
    expect(parsePersonnelListQuery({ bucket: 'withhold' }).filters.employmentStatuses).toBeUndefined();
    expect(parsePersonnelListQuery({ bucket: 'nonsense' }).filters.employmentStatuses).toBeUndefined();
  });

  it('treats Draft as a selection of the OTHER table, from either param', () => {
    expect(parsePersonnelListQuery({ bucket: 'draft' }).draftOnly).toBe(true);
    expect(parsePersonnelListQuery({ status: 'draft' }).draftOnly).toBe(true);
    expect(parsePersonnelListQuery({ bucket: 'draft' }).filters.employmentStatuses).toBeUndefined();
    expect(parsePersonnelListQuery({}).draftOnly).toBe(false);
  });

  it('the cards are counted with the bucket stripped and everything else kept', () => {
    const query = parsePersonnelListQuery({ bucket: 'active', company: 'c1', dept: 'd1', q: 'ali', type: 'contract' });
    const cards = headcountFilters(query);
    expect(cards.employmentStatuses).toBeUndefined();
    expect(cards.companyId).toBe('c1');
    expect(cards.departmentId).toBe('d1');
    expect(cards.q).toBe('ali');
    expect(cards.employmentType).toBe('contract');
  });

  it('hides drafts behind exactly the filters a draft cannot answer', () => {
    const draft = { companyId: 'c1', label: 'abc', reservedEmployeeCode: 'X00010', companyName: 'Demo Sdn Bhd' };
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({}))).toBe(true);
    // Company and the search box genuinely apply.
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ company: 'c1' }))).toBe(true);
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ company: 'c2' }))).toBe(false);
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ q: 'X00010' }))).toBe(true);
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ q: 'zzz' }))).toBe(false);
    // Department, employment type and any employment bucket hide every draft — it has none of them.
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ dept: 'd1' }))).toBe(false);
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ type: 'contract' }))).toBe(false);
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ bucket: 'active' }))).toBe(false);
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ status: 'active' }))).toBe(false);
    // …and the Draft selection shows them.
    expect(draftMatchesQuery(draft, parsePersonnelListQuery({ bucket: 'draft' }))).toBe(true);
  });

  /**
   * THE DRAFT CARD COUNTS WHAT CLICKING IT WOULD SHOW.
   *
   * Found by RENDERING, not by a test: with Active selected the Draft card read "0" beside two records
   * that plainly existed, because the count was taken under the bucket already chosen. Clicking a card
   * REPLACES the bucket, so the honest preview strips it — every other count on the page was
   * individually correct, which is exactly why nothing caught it.
   */
  it('previews the Draft count with the chosen bucket set aside', () => {
    const draft = { companyId: 'c1', label: 'abc', reservedEmployeeCode: 'X00010', companyName: 'Demo Sdn Bhd' };
    const chosen = parsePersonnelListQuery({ bucket: 'active' });
    expect(draftMatchesQuery(draft, chosen)).toBe(false); // the ROWS: no draft is in an employment bucket
    expect(draftMatchesQuery(draft, { ...chosen, bucket: undefined })).toBe(true); // the CARD: click me
    // A filter a draft genuinely cannot satisfy still zeroes the card, because clicking KEEPS that
    // filter — so the card and the rows it leads to still agree.
    const byDept = parsePersonnelListQuery({ dept: 'd1', bucket: 'active' });
    expect(draftMatchesQuery(draft, { ...byDept, bucket: undefined })).toBe(false);
  });
});

describe('579255c3 — the page wires the Draft card to that preview, not to the visible rows', () => {
  it('reads draftCardCount rather than the filtered row list', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../app/admin/personnel/page.tsx', import.meta.url), 'utf8');
    expect(src).toContain('const draftCardCount = allDrafts.filter');
    expect(src).toContain('bucket: undefined');
    expect(src).toContain("count: draftCardCount");
    // The ROWS still come from the full query — the two must not be collapsed back into one.
    expect(src).toContain('const matchingDrafts = allDrafts.filter((d) => draftMatchesQuery(d, query));');
  });
});
