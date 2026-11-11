/**
 * Groups of open payroll exceptions: one group per check, severity and (where the check has one) variant. PURE.
 *
 * The figures come from a bounded aggregate over EVERY open exception (app/control-tower/exceptions/data.ts, GROUP BY in
 * the database), never from a capped page of rows, so "31 people" means 31 however long the queue is. This file only
 * classifies, orders and describes those aggregate rows.
 */
import { checkCopy, entryOf, fixTabOf, type CheckCopy, type RecordTab } from './catalogue';
import { bucketOf, isBlocking, type Bucket, BUCKETS } from './classify';

export type GroupIdentity = Readonly<{ checkId: string; severity: string; variant: string | null }>;

export type GroupAggregateRow = GroupIdentity & Readonly<{
  /** Open exceptions (verdicts) with at least one finding in this group. */
  exceptions: number;
  people: number;
  companies: number;
  runs: number;
  /** Of those runs, the ones not yet closed. Absent = all open. */
  openRuns?: number;
  /** A few company names, alphabetically, for set-up groups. */
  companyNames: readonly string[];
}>;

/** What the group's main button does. Blocking groups are only ever worked one by one. */
export type GroupAction = 'one_by_one' | 'fix_records' | 'mark_expected' | 'review';

export type ExceptionGroup = GroupAggregateRow & Readonly<{
  key: string;
  bucket: Bucket;
  blocking: boolean;
  /** Blocking, but every run it is in is already closed, so it holds nothing up now. */
  closedRunsOnly: boolean;
  /** True only for a non-blocking set-up group: the one kind that may be marked as expected in bulk. */
  bulkExpect: boolean;
  action: GroupAction;
  fixTab: RecordTab | null;
  copy: CheckCopy;
}>;

const SEVERITIES = new Set(['block', 'review', 'info']);
const CHECK_ID = /^[a-z][a-z0-9-]{0,63}$/;
const VARIANT = /^[A-Za-z0-9-]{1,64}$/;

/** `negative-net.block.-` — safe in a URL and a form value; never rendered. */
export const groupKey = (g: GroupIdentity) => `${g.checkId}.${g.severity}.${g.variant ?? '-'}`;

/** The inverse of `groupKey`, refusing anything that is not one. */
export function parseGroupKey(value: unknown): GroupIdentity | null {
  if (typeof value !== 'string' || value.length > 160) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [checkId, severity, variant] = parts;
  if (!CHECK_ID.test(checkId) || !SEVERITIES.has(severity)) return null;
  if (variant !== '-' && !VARIANT.test(variant)) return null;
  return { checkId, severity, variant: variant === '-' ? null : variant };
}

/** May this group be marked as expected in bulk? Never when it blocks a run, never outside the set-up bucket. */
export function mayBulkExpect(g: GroupIdentity): boolean {
  return !isBlocking(g.severity) && bucketOf(g.checkId, g.severity) === 'setup';
}

function actionOf(bucket: Bucket, blocking: boolean, bulk: boolean): GroupAction {
  if (bucket === 'missing') return 'fix_records';
  if (blocking) return 'one_by_one';
  if (bulk) return 'mark_expected';
  return 'review';
}

export function describeGroup(row: GroupAggregateRow): ExceptionGroup {
  const bucket = bucketOf(row.checkId, row.severity);
  const blocking = isBlocking(row.severity);
  const bulkExpect = mayBulkExpect(row);
  return Object.freeze({
    ...row,
    key: groupKey(row),
    bucket,
    blocking,
    closedRunsOnly: blocking && row.openRuns !== undefined && row.openRuns === 0,
    bulkExpect,
    action: actionOf(bucket, blocking, bulkExpect),
    fixTab: fixTabOf(row.checkId, row.variant),
    copy: checkCopy(row.checkId, row.variant),
  });
}

const CATALOGUE_ORDER = (checkId: string) => {
  const ids = ['negative-net', 'statutory-over-cap', 'duplicate-employment-pay', 'missing-bank-profile', 'zero-net-with-pay',
    'net-swing', 'proration-mismatch', 'hypothesis', 'missing-tax-profile', 'pay-without-attendance', 'component-appeared', 'component-vanished'];
  const at = ids.indexOf(checkId);
  return at < 0 ? ids.length + (entryOf(checkId) ? 0 : 1) : at;
};

/** Every group, worst first: by bucket, blocking before not, then the most exceptions, then a fixed check order. */
export function buildGroups(rows: readonly GroupAggregateRow[]): readonly ExceptionGroup[] {
  return Object.freeze(rows.filter(row => row.exceptions > 0).map(describeGroup).sort((a, b) =>
    BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket)
    || Number(b.blocking) - Number(a.blocking)
    || b.exceptions - a.exceptions
    || CATALOGUE_ORDER(a.checkId) - CATALOGUE_ORDER(b.checkId)
    || a.key.localeCompare(b.key)));
}

/** How many named companies a set-up group lists before "and N more". */
export const COMPANY_NAMES_SHOWN = 3;
