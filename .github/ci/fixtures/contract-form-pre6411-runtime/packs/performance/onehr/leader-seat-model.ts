/**
 * WP-B2 (APR-022) — pure rules for leader seats, head-of-department (HOD) changes and the leader import.
 *
 * The database owns authority and invariants (migration 0663): who may write, one holder per anchor per
 * day, no backdating, rows ended and never deleted. This module holds only what is computed before a write:
 * date arithmetic, the HOD change plan partition, the preview fingerprint and the import row mapping.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const LEADER_SEAT_TYPES = ['bu_ceo', 'bg_ceo', 'group_chief'] as const;
export type LeaderSeatType = (typeof LEADER_SEAT_TYPES)[number];
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.');

/** Date-only arithmetic on an ISO day (UTC arithmetic on a calendar date, never "now"). */
export function addDaysIso(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A dated row is live on `day` when valid_from <= day < valid_to (valid_to exclusive, null = open). */
export function liveOn(row: { validFrom: string; validTo: string | null }, day: string): boolean {
  return row.validFrom <= day && (row.validTo === null || row.validTo > day);
}

// ── HOD change plan ─────────────────────────────────────────────────────────────────────────────────────

export type HodBlockerCode = 'old_hod_review_submitted' | 'new_hod_review_submitted' | 'bu_review_locked' | 'bg_review_locked';
export type HodWarningCode = 'old_hod_decision_dropped' | 'former_hod_heads_nobody' | 'new_hod_review_closed' | 'import_overwrites' | 'future_dated_sessions_not_moved';
/** A blocker names the people it concerns; an override with a reason is the only way past one. */
export type HodBlocker = { code: HodBlockerCode; employmentIds: string[] };
/** A warning must be acknowledged before apply. `employmentIds` are the people (or former HODs) it concerns. */
export type HodWarning = { code: HodWarningCode; employmentIds: string[] };
export type HodSubject = { employmentId: string; personId: string; currentHodEmploymentId: string | null };
export type HodPlanRow = { subjectEmploymentId: string; currentHodEmploymentId: string | null; nextHodEmploymentId: string | null };
export type HodOnly = 'all' | 'unset' | string;

/**
 * Splits the picked people into the rows that change, those already at the target, and the HOD themself
 * (nobody is their own HOD). `only` narrows to people with no HOD ('unset') or to one current HOD.
 */
export function partitionHodPlan(subjects: readonly HodSubject[], next: { employmentId: string; personId: string } | null, only: HodOnly = 'all') {
  const rows: HodPlanRow[] = [];
  let unchanged = 0, selfExcluded = 0;
  const seen = new Set<string>();
  for (const s of [...subjects].sort((a, b) => a.employmentId.localeCompare(b.employmentId))) {
    if (seen.has(s.employmentId)) continue;
    seen.add(s.employmentId);
    if (only === 'unset' && s.currentHodEmploymentId !== null) continue;
    if (only !== 'all' && only !== 'unset' && s.currentHodEmploymentId !== only) continue;
    if (next && s.personId === next.personId) { selfExcluded++; continue; }
    if (s.currentHodEmploymentId === (next?.employmentId ?? null)) { unchanged++; continue; }
    rows.push({ subjectEmploymentId: s.employmentId, currentHodEmploymentId: s.currentHodEmploymentId, nextHodEmploymentId: next?.employmentId ?? null });
  }
  return { rows, unchanged, selfExcluded };
}

const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();
/** Canonical issue lists: one entry per code, ids sorted and unique, codes in a fixed order, empty lists dropped. */
export function canonicalIssues<C extends string>(issues: readonly { code: C; employmentIds: readonly string[] }[], order: readonly C[]): { code: C; employmentIds: string[] }[] {
  const by = new Map<C, Set<string>>();
  for (const i of issues) { const set = by.get(i.code) ?? new Set<string>(); for (const id of i.employmentIds) set.add(id); by.set(i.code, set); }
  return order.filter((code) => by.has(code)).map((code) => ({ code, employmentIds: sortedIds(by.get(code)!) }));
}
export const HOD_BLOCKER_ORDER: readonly HodBlockerCode[] = ['old_hod_review_submitted', 'new_hod_review_submitted', 'bu_review_locked', 'bg_review_locked'];
export const HOD_WARNING_ORDER: readonly HodWarningCode[] = ['old_hod_decision_dropped', 'former_hod_heads_nobody', 'new_hod_review_closed', 'import_overwrites', 'future_dated_sessions_not_moved'];

/**
 * The preview fingerprint: apply recomputes the plan inside its own transaction and refuses unless the
 * fingerprint matches, so a change made between preview and apply (someone else's HOD change, a new lock)
 * can never be written unseen.
 */
export function hodPlanFingerprint(plan: { validFrom: string; hodEmploymentId: string | null; source: string; rows: readonly HodPlanRow[]; blockers: readonly HodBlocker[]; warnings: readonly HodWarning[] }): string {
  const canonical = {
    validFrom: plan.validFrom, hod: plan.hodEmploymentId, source: plan.source,
    rows: [...plan.rows].map((r) => [r.subjectEmploymentId, r.currentHodEmploymentId, r.nextHodEmploymentId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    blockers: plan.blockers.map((b) => [b.code, sortedIds(b.employmentIds)]),
    warnings: plan.warnings.map((w) => [w.code, sortedIds(w.employmentIds)]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ── Leader import (already-parsed rows) ─────────────────────────────────────────────────────────────────

/** Blank leaves the current value as it is; NONE removes it, as in the source roster columns. */
export const LEADER_IMPORT_NONE = 'NONE';
export const leaderImportSchema = z.object({
  hodRows: z.array(z.object({ employeeCode: z.string().trim().min(1).max(100), hod: z.string().trim().max(100) })).max(20000).default([]),
  seatRows: z.array(z.object({
    seatType: z.enum(LEADER_SEAT_TYPES),
    anchor: z.string().trim().min(1).max(300),
    holder: z.string().trim().max(100),
    validFrom: isoDate.optional(),
  })).max(5000).default([]),
});
export type LeaderImportInput = z.input<typeof leaderImportSchema>;
export type LeaderImportLookups = {
  /** Employee code (case-insensitive) → the tenant's live employments carrying it. */
  employmentsByCode: ReadonlyMap<string, readonly string[]>;
  /** Company label or legal name (case-insensitive) → company ids. */
  companiesByKey: ReadonlyMap<string, readonly string[]>;
  /** Live calibration group name (case-insensitive) → group ids. */
  groupsByName: ReadonlyMap<string, readonly string[]>;
};
export type LeaderImportError = { kind: 'hod' | 'seat'; line: number; message: string };
export type LeaderImportSeatChange = { line: number; seatType: LeaderSeatType; companyId: string | null; calibrationGroupId: string | null; holderEmploymentId: string | null; validFrom: string | null };
export type LeaderImportPlan = {
  /** HOD changes grouped by the target HOD (null = remove), subjects sorted. */
  hod: { hodEmploymentId: string | null; subjectEmploymentIds: string[] }[];
  seats: LeaderImportSeatChange[];
  errors: LeaderImportError[];
};

const key = (v: string) => v.trim().toLowerCase();
function one(map: ReadonlyMap<string, readonly string[]>, value: string): { id: string } | { error: 'unknown' | 'ambiguous' } {
  const ids = map.get(key(value)) ?? [];
  return ids.length === 1 ? { id: ids[0] } : { error: ids.length ? 'ambiguous' : 'unknown' };
}

/**
 * Maps parsed rows onto the same writers the screen uses. External identifiers resolve to existing
 * employments, companies and groups only: nothing is created, and an unknown or ambiguous identifier is an
 * error on its line. Lines are 1-based within each row list.
 */
export function mapLeaderImport(raw: LeaderImportInput, lookups: LeaderImportLookups): LeaderImportPlan {
  const input = leaderImportSchema.parse(raw);
  const errors: LeaderImportError[] = [];
  const byTarget = new Map<string | null, Set<string>>();
  const subjectsSeen = new Map<string, number>();
  input.hodRows.forEach((row, i) => {
    const line = i + 1;
    if (row.hod === '') return;
    const subject = one(lookups.employmentsByCode, row.employeeCode);
    if ('error' in subject) { errors.push({ kind: 'hod', line, message: `Employee ID ${row.employeeCode} is ${subject.error}.` }); return; }
    const earlier = subjectsSeen.get(subject.id);
    if (earlier) { errors.push({ kind: 'hod', line, message: `Employee ID ${row.employeeCode} already appears on line ${earlier}.` }); return; }
    subjectsSeen.set(subject.id, line);
    let target: string | null = null;
    if (row.hod.toUpperCase() !== LEADER_IMPORT_NONE) {
      const hod = one(lookups.employmentsByCode, row.hod);
      if ('error' in hod) { errors.push({ kind: 'hod', line, message: `HOD employee ID ${row.hod} is ${hod.error}.` }); return; }
      target = hod.id;
    }
    const set = byTarget.get(target) ?? new Set<string>();
    set.add(subject.id);
    byTarget.set(target, set);
  });
  const seats: LeaderImportSeatChange[] = [];
  const anchorsSeen = new Map<string, number>();
  input.seatRows.forEach((row, i) => {
    const line = i + 1;
    if (row.holder === '') return;
    const anchor = row.seatType === 'group_chief' ? one(lookups.groupsByName, row.anchor) : one(lookups.companiesByKey, row.anchor);
    if ('error' in anchor) { errors.push({ kind: 'seat', line, message: `${row.seatType === 'group_chief' ? 'Calibration group' : 'Company'} ${row.anchor} is ${anchor.error}.` }); return; }
    const anchorKey = `${row.seatType}:${anchor.id}`, earlier = anchorsSeen.get(anchorKey);
    if (earlier) { errors.push({ kind: 'seat', line, message: `This seat already appears on line ${earlier}.` }); return; }
    anchorsSeen.set(anchorKey, line);
    let holder: string | null = null;
    if (row.holder.toUpperCase() !== LEADER_IMPORT_NONE) {
      const h = one(lookups.employmentsByCode, row.holder);
      if ('error' in h) { errors.push({ kind: 'seat', line, message: `Employee ID ${row.holder} is ${h.error}.` }); return; }
      holder = h.id;
    }
    seats.push({ line, seatType: row.seatType, companyId: row.seatType === 'group_chief' ? null : anchor.id, calibrationGroupId: row.seatType === 'group_chief' ? anchor.id : null, holderEmploymentId: holder, validFrom: row.validFrom ?? null });
  });
  const hod = [...byTarget.entries()]
    .map(([hodEmploymentId, set]) => ({ hodEmploymentId, subjectEmploymentIds: sortedIds(set) }))
    .sort((a, b) => (a.hodEmploymentId ?? '').localeCompare(b.hodEmploymentId ?? ''));
  return { hod, seats, errors };
}
