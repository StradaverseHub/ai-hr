/**
 * The grouped Exceptions page's reads (AI-native batch, 11 November 2026).
 *
 * WHICH EXCEPTIONS. Exactly the population `openExceptionsAcrossRuns` (core/payroll-anomaly.ts) reads, which is what
 * Today counts: live (not superseded), unresolved, not auto-cleared verdicts, joined to their employment, person and
 * payroll run, all under the viewer's own row-level security. The same predicates and the same inner joins, so a
 * verdict the viewer may not see is in neither, and the two screens print the same totals.
 *
 * COUNTS OVER EVERYTHING, ROWS BOUNDED. Every figure on the page (the totals, the three buckets, each group's people,
 * runs and companies) is a GROUP BY in the database over every open exception, never a count of a capped page. The rows
 * that are listed are bounded: a few per group, or one page of one group, in the old reader's order (blocking first,
 * then the longest waiting).
 *
 * AUTHORIZE FIRST, FEW TRIPS. The page has run requireAdmin before calling this, and this refuses a non-administrator
 * again before opening a transaction. Everything is read in ONE transaction of four bounded statements. No figure is
 * computed, no model is called and nothing is written.
 */
import { sql, type SQL } from 'drizzle-orm';
import { withBackgroundReadWork, withTenant, type SessionContext, type Tx } from '@/db/client';
import { isAdmin } from '@/lib/authz-model';
import {
  CATALOGUE, COMPANY_NAMES_SHOWN, OTHER_COMPONENT, bucketCounts, buildGroups, groupKey,
  type Bucket, type ExceptionGroup, type GroupIdentity,
} from '@/lib/payroll-exceptions';

/** Rows listed under each group on the overview. The group's own count is always the full one. */
export const PREVIEW_PER_GROUP = 3;
/** Rows on one page of one group. Equal to BULK_EXPECT_MAX, so one page is at most one bulk press. */
export const GROUP_PAGE_SIZE = 25;
/** Distinct groups (check × severity × variant). The catalogue has about 35; this bound only guards stray ids. */
const GROUP_LIMIT = 200;
/** Distinct finding signatures for the bucket figures. Exact totals are computed over all of them regardless. */
const SIGNATURE_LIMIT = 500;
/** Months with an open blocking exception whose acknowledged blocks are listed. */
export const BLOCK_PERIODS_LIMIT = 12;

export type ExceptionItem = Readonly<{
  verdictId: string;
  employmentId: string;
  batchId: string;
  disposition: string;
  computedAt: Date;
  payPeriod: string;
  checkId: string;
  severity: string;
  variant: string | null;
  facts: Readonly<Record<string, unknown>>;
  narrative: string | null;
  name: string;
  employeeCode: string | null;
  currency: string | null;
  /** Every finding of the verdict, as `<check>:<severity>`. */
  signature: readonly string[];
}>;

export type GroupedExceptions = Readonly<{
  total: number;
  blocking: number;
  buckets: Record<Bucket, number>;
  /** True when the bucket split was read from the largest SIGNATURE_LIMIT signatures only; totals stay exact. */
  bucketsPartial: boolean;
  groups: readonly ExceptionGroup[];
  groupsCapped: boolean;
  /** Bounded rows per group key: a preview of each, or one page of the focused group. */
  items: ReadonlyMap<string, readonly ExceptionItem[]>;
  /** Months with an open blocking exception, newest first, at most BLOCK_PERIODS_LIMIT. */
  blockPeriods: readonly string[];
}>;

export class ExceptionsReadRefused extends Error {
  constructor() { super('Exceptions unavailable.'); this.name = 'ExceptionsReadRefused'; }
}

/** The page's independent reads share one passive admission (FUTURE-BUILD-CONTRACT: fan-out reads). */
export const pageReadAdmission = <T>(s: SessionContext, read: () => Promise<T>) => withBackgroundReadWork(s.tenantId, read);

const rows = async <T>(tx: Tx, query: SQL) => Array.from(await tx.execute(query)) as unknown as T[];

/** The open population, as `openExceptionsAcrossRuns` selects it. */
const OPEN = sql`open_v as (
  select v.id, v.employment_id, v.batch_id, v.disposition, v.computed_at, b.company_id, b.pay_period
  from public.payroll_anomaly_verdict v
  join public.employment e on e.id = v.employment_id
  join public.person p on p.id = e.person_id
  join public.payroll_batch b on b.id = v.batch_id
  where v.superseded_at is null and v.resolved_at is null and v.disposition <> 'auto_clear')`;

/** The sub-group of a finding, generated from the catalogue so it cannot drift from `variantOf`. */
export function variantSql(): SQL {
  const whens: SQL[] = [];
  for (const [checkId, entry] of Object.entries(CATALOGUE)) {
    const variant = entry.variant;
    if (!variant) continue;
    const values = sql.join(variant.values.map(value => sql`${value}`), sql`, `);
    const otherwise = variant.otherwise === 'other' ? sql`${OTHER_COMPONENT}::text` : sql`null::text`;
    whens.push(sql`when f.detector_id = ${checkId} then case when f.facts->>${variant.fact}::text in (${values}) then f.facts->>${variant.fact}::text else ${otherwise} end`);
  }
  return sql`(case ${sql.join(whens, sql` `)} else null::text end)`;
}

const FINDINGS = () => sql`fv as (
  select f.id as finding_id, f.verdict_id, f.detector_id as check_id, f.severity, ${variantSql()} as variant, f.facts, f.narrative
  from public.payroll_anomaly_finding f where f.verdict_id in (select id from open_v))`;

type SignatureRow = { disposition: string; signature: string[] | null; n: number; total: number; blocking: number; signatures: number };
type GroupRow = { check_id: string; severity: string; variant: string | null; exceptions: number; people: number; companies: number; runs: number; company_names: string[] | null };
type ItemRow = { verdict_id: string; employment_id: string; batch_id: string; disposition: string; computed_at: Date | string; pay_period: string;
  check_id: string; severity: string; variant: string | null; facts: Record<string, unknown> | null; narrative: string | null; full_name: string | null;
  employee_code: string | null; currency: string | null; signature: string[] | null };

function itemsQuery(where: { group: GroupIdentity; offset: number; limit: number } | { preview: number }): SQL {
  const filter = 'group' in where
    ? sql`where fv.check_id = ${where.group.checkId} and fv.severity = ${where.group.severity} and fv.variant is not distinct from ${where.group.variant}::text`
    : sql``;
  const rank = 'group' in where
    ? sql`r.rn > ${where.offset} and r.rn <= ${where.offset + where.limit}`
    : sql`r.rn <= ${where.preview}`;
  return sql`with ${OPEN}, ${FINDINGS()},
    per as (
      select distinct on (fv.check_id, fv.severity, fv.variant, o.id)
        o.id as verdict_id, o.employment_id, o.batch_id, o.disposition, o.computed_at, o.company_id, o.pay_period,
        fv.check_id, fv.severity, fv.variant, fv.facts, fv.narrative
      from fv join open_v o on o.id = fv.verdict_id
      ${filter}
      order by fv.check_id, fv.severity, fv.variant, o.id, fv.finding_id),
    ranked as (select per.*, row_number() over (partition by check_id, severity, variant
      order by case disposition when 'block' then 0 when 'review' then 1 else 2 end, computed_at, verdict_id) as rn from per)
    select r.verdict_id, r.employment_id, r.batch_id, r.disposition, r.computed_at, r.pay_period, r.check_id, r.severity, r.variant,
      r.facts, r.narrative, p.full_name, e.employee_code, c.currency,
      (select array_agg(distinct f2.detector_id || ':' || f2.severity) from public.payroll_anomaly_finding f2 where f2.verdict_id = r.verdict_id) as signature
    from ranked r
    join public.employment e on e.id = r.employment_id
    join public.person p on p.id = e.person_id
    left join public.company c on c.id = r.company_id
    where ${rank}
    order by r.check_id, r.severity, r.variant nulls first, r.rn`;
}

const toItem = (row: ItemRow): ExceptionItem => Object.freeze({
  verdictId: row.verdict_id, employmentId: row.employment_id, batchId: row.batch_id, disposition: row.disposition,
  computedAt: row.computed_at instanceof Date ? row.computed_at : new Date(row.computed_at), payPeriod: row.pay_period,
  checkId: row.check_id, severity: row.severity, variant: row.variant, facts: Object.freeze({ ...(row.facts ?? {}) }), narrative: row.narrative,
  name: row.full_name ?? '', employeeCode: row.employee_code, currency: row.currency, signature: Object.freeze([...(row.signature ?? [])].sort()),
});

/**
 * Every open exception, grouped. With `focus`, the listed rows are one page of that group instead of a preview of each.
 */
export async function groupedExceptions(s: SessionContext, p: { focus?: GroupIdentity | null; page?: number } = {}): Promise<GroupedExceptions> {
  if (!s.userId || !isAdmin(s)) throw new ExceptionsReadRefused();
  const page = Math.max(1, Math.min(10_000, Math.floor(p.page ?? 1)));
  return withTenant(s, async tx => {
    const signatures = await rows<SignatureRow>(tx, sql`with ${OPEN},
      sig as (
        select o.id, o.disposition,
          coalesce(array_agg(distinct f.detector_id || ':' || f.severity) filter (where f.id is not null), '{}'::text[]) as signature
        from open_v o left join public.payroll_anomaly_finding f on f.verdict_id = o.id
        group by o.id, o.disposition)
      select disposition, signature, count(*)::int as n,
        (sum(count(*)) over ())::int as total,
        (sum(count(*) filter (where disposition = 'block')) over ())::int as blocking,
        (count(*) over ())::int as signatures
      from sig group by disposition, signature
      order by n desc, disposition, signature
      limit ${SIGNATURE_LIMIT}`);
    const total = signatures[0]?.total ?? 0;
    const blocking = signatures[0]?.blocking ?? 0;
    if (total === 0) {
      return Object.freeze({ total: 0, blocking: 0, buckets: { check: 0, missing: 0, setup: 0 }, bucketsPartial: false, groups: [], groupsCapped: false,
        items: new Map(), blockPeriods: [] });
    }
    const periods = await rows<{ pay_period: string }>(tx, sql`with ${OPEN}
      select distinct pay_period from open_v where disposition = 'block' order by pay_period desc limit ${BLOCK_PERIODS_LIMIT}`);
    const groupRows = await rows<GroupRow>(tx, sql`with ${OPEN}, ${FINDINGS()}
      select fv.check_id, fv.severity, fv.variant,
        count(distinct o.id)::int as exceptions, count(distinct o.employment_id)::int as people,
        count(distinct o.company_id)::int as companies, count(distinct o.batch_id)::int as runs,
        (array_agg(distinct c.legal_name) filter (where c.legal_name is not null))[1:${sql.raw(String(COMPANY_NAMES_SHOWN))}] as company_names
      from fv join open_v o on o.id = fv.verdict_id left join public.company c on c.id = o.company_id
      group by fv.check_id, fv.severity, fv.variant
      order by exceptions desc, fv.check_id, fv.severity, fv.variant nulls first
      limit ${GROUP_LIMIT + 1}`);
    const groups = buildGroups(groupRows.slice(0, GROUP_LIMIT).map(row => ({
      checkId: row.check_id, severity: row.severity, variant: row.variant, exceptions: row.exceptions, people: row.people,
      companies: row.companies, runs: row.runs, companyNames: Object.freeze([...(row.company_names ?? [])]),
    })));
    const focus = p.focus ? groups.find(group => group.key === groupKey(p.focus!)) ?? null : null;
    const itemRows = focus
      ? await rows<ItemRow>(tx, itemsQuery({ group: focus, offset: (page - 1) * GROUP_PAGE_SIZE, limit: GROUP_PAGE_SIZE }))
      : p.focus ? [] : await rows<ItemRow>(tx, itemsQuery({ preview: PREVIEW_PER_GROUP }));
    const items = new Map<string, ExceptionItem[]>();
    for (const row of itemRows) {
      const item = toItem(row);
      const key = groupKey(item);
      items.set(key, [...(items.get(key) ?? []), item]);
    }
    return Object.freeze({
      total, blocking,
      buckets: bucketCounts(signatures.map(row => ({ disposition: row.disposition, signature: row.signature ?? [], count: row.n }))),
      bucketsPartial: (signatures[0]?.signatures ?? 0) > signatures.length,
      groups, groupsCapped: groupRows.length > GROUP_LIMIT,
      items, blockPeriods: Object.freeze(periods.map(row => row.pay_period)),
    });
  });
}
