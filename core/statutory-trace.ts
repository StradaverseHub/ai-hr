/**
 * Item 69d6ed3c — THE KERNEL HALF OF STATUTORY TRACE v1.
 *
 * The country pack's `statutory()` records, from the same statements that produce each amount, which table
 * row (or formula) EPF, SOCSO, SKBBK and EIS were read on (`StatutoryTraceV1`, localization/my/payroll.ts).
 * The pack cannot know WHICH PAY ITEMS made up the wages it was handed — only the kernel folded them — so
 * the kernel adds two things here, both pure and both from figures the run already holds:
 *
 *   1. `buildStatutoryTraceLines` — one line per pay item (and per non-item component of the wage: basic,
 *      unpaid leave, earlier runs in the month), each carrying the item's EPF / EPF Bonus 2012 / SOCSO
 *      settings AS THIS RUN READ THEM and the money it contributed to each base. The lines are made to add
 *      up to the bases the pack was called with; anything the item list cannot account for (a clamp, a
 *      legacy untyped allowance, an overtime cap) is disclosed as one `other` line rather than hidden.
 *
 *   2. `readRunStatutoryStamp` — the per-run figures a LATER run in the same month needs: how much of this
 *      run's additional pay was actually subject to EPF, and how much of it was SOCSO/EIS wages. This is the
 *      fix for the multi-run defect: earlier runs used to be counted at their GROSS bonus, so a bonus that
 *      was not ticked for EPF became EPF wages in every later run of the month.
 *
 * Nothing here reads a database, a session or today's configuration.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

export type StatutoryTraceLineKind = 'basic' | 'item' | 'unpaid' | 'overtime' | 'earlier_runs' | 'other';

export type StatutoryTraceLine = {
  kind: StatutoryTraceLineKind;
  code?: string;
  name?: string;
  /** The money the line carries on this run (negative for a deduction). Absent on `other`. */
  amount?: number;
  /** The pay item's settings as this run folded it. Present on `item` lines only. */
  epf?: boolean;
  epfBonus2012?: boolean;
  socso?: boolean;
  /** What the line contributed to each statutory base. Each column sums to that base exactly. */
  epfNormal: number;
  epfBonus: number;
  socsoEis: number;
};

type Bucket = 'wage' | 'ot' | 'bonus' | 'reimburse' | 'deduct';
export type TraceSourceLine = {
  code: string;
  name: string;
  buckets: { bucket: Bucket; amount: number }[];
  epf: boolean;
  socso: boolean;
  /** 2026-11-13 — the line's `bonus` money is NORMAL EPF wages (see PayComponentLine in core/payroll.ts). */
  epfNormalStream?: true;
  /** 2026-11-13 — the line's `reimburse` money is a PCB-exempt slice counted in the agency bases by its ticks. */
  exemptStatutory?: true;
};

/**
 * Lay the run's own folded pay items against the three bases the pack charged. Treatment per bucket is the
 * kernel's own routing (core/payroll.ts `earningsOf`), restated — not re-decided:
 *   wage      → EPF normal wages if ticked EPF; SOCSO/EIS wages if ticked SOCSO;
 *   bonus     → if ticked EPF: EPF NORMAL wages on a line stamped `epfNormalStream` (an 'additional'-classified
 *               item not ticked EPF Bonus 2012 — owner decision B, 2026-11-13), otherwise EPF bonus wages;
 *               SOCSO/EIS wages only if ticked SOCSO AND not EPF Bonus 2012 (a declared bonus is not SOCSO
 *               wages, SOCSO Act 1969 s.2);
 *   ot        → never EPF; always SOCSO/EIS wages (on a run that charges its own overtime);
 *   reimburse → no base, EXCEPT on a line stamped `exemptStatutory`: a PCB-exempt slice, which follows the
 *               item's ticks exactly as its taxable money does (owner decision A, 2026-11-13) — EPF normal
 *               (EPF bonus under EPF Bonus 2012), SOCSO/EIS if ticked and not EPF Bonus 2012;
 *   deduct    → out of each base whose box is ticked.
 */
export function buildStatutoryTraceLines(p: {
  basic: number;
  lines: readonly TraceSourceLine[];
  bonus2012Codes: ReadonlySet<string>;
  /** False on an additional run: its statutory overtime is the regular run's, not its own fold. */
  ownOvertimeCharged: boolean;
  unpaid: number;
  /** The regular run's overtime an additional run's SOCSO/EIS month carries. */
  regularOvertime?: number;
  earlier?: { epfNormal: number; epfBonus: number; socsoEis: number };
  totals: { epfNormal: number; epfBonus: number; socsoEis: number };
}): StatutoryTraceLine[] {
  const out: StatutoryTraceLine[] = [];
  if (p.basic !== 0) out.push({ kind: 'basic', amount: round2(p.basic), epfNormal: round2(p.basic), epfBonus: 0, socsoEis: round2(p.basic) });
  for (const l of p.lines) {
    const b2012 = p.bonus2012Codes.has(l.code);
    let amount = 0, epfNormal = 0, epfBonus = 0, socsoEis = 0;
    for (const { bucket, amount: a } of l.buckets) {
      if (bucket === 'deduct') {
        amount = round2(amount - a);
        if (l.epf) epfNormal = round2(epfNormal - a);
        if (l.socso) socsoEis = round2(socsoEis - a);
        continue;
      }
      if (bucket === 'ot' && !p.ownOvertimeCharged) continue;
      amount = round2(amount + a);
      if (bucket === 'wage') {
        if (l.epf) epfNormal = round2(epfNormal + a);
        if (l.socso) socsoEis = round2(socsoEis + a);
      } else if (bucket === 'bonus') {
        if (l.epf && l.epfNormalStream && !b2012) epfNormal = round2(epfNormal + a);
        else if (l.epf) epfBonus = round2(epfBonus + a);
        if (l.socso && !b2012) socsoEis = round2(socsoEis + a);
      } else if (bucket === 'reimburse' && l.exemptStatutory) {
        if (l.epf && b2012) epfBonus = round2(epfBonus + a);
        else if (l.epf) epfNormal = round2(epfNormal + a);
        if (l.socso && !b2012) socsoEis = round2(socsoEis + a);
      } else if (bucket === 'ot') {
        socsoEis = round2(socsoEis + a);
      }
    }
    if (amount === 0 && epfNormal === 0 && epfBonus === 0 && socsoEis === 0) continue;
    out.push({ kind: 'item', code: l.code, name: l.name, amount, epf: l.epf, epfBonus2012: b2012, socso: l.socso, epfNormal, epfBonus, socsoEis });
  }
  if (p.unpaid !== 0) out.push({ kind: 'unpaid', amount: round2(-p.unpaid), epfNormal: round2(-p.unpaid), epfBonus: 0, socsoEis: round2(-p.unpaid) });
  if (p.regularOvertime) out.push({ kind: 'overtime', amount: round2(p.regularOvertime), epfNormal: 0, epfBonus: 0, socsoEis: round2(p.regularOvertime) });
  if (p.earlier && (p.earlier.epfNormal || p.earlier.epfBonus || p.earlier.socsoEis)) {
    out.push({ kind: 'earlier_runs', epfNormal: round2(p.earlier.epfNormal), epfBonus: round2(p.earlier.epfBonus), socsoEis: round2(p.earlier.socsoEis) });
  }
  const sum = (k: 'epfNormal' | 'epfBonus' | 'socsoEis') => out.reduce((acc, l) => round2(acc + l[k]), 0);
  const other = {
    epfNormal: round2(p.totals.epfNormal - sum('epfNormal')),
    epfBonus: round2(p.totals.epfBonus - sum('epfBonus')),
    socsoEis: round2(p.totals.socsoEis - sum('socsoEis')),
  };
  if (other.epfNormal !== 0 || other.epfBonus !== 0 || other.socsoEis !== 0) out.push({ kind: 'other', ...other });
  return out;
}

/**
 * This run's own figures that later runs in the same month read back.
 *
 * 2026-11-13 (owner decisions A/B) adds four, all ABSENT on every stamp written before and read as 0 there —
 * which is exactly how those runs were computed:
 *   epfWageExtra         — of this run's additional pay, the part that is NORMAL EPF wages (an
 *                          'additional'-classified item ticked EPF, not EPF Bonus 2012);
 *   exemptEpfWage        — PCB-exempt one-off money a regular run paid that is EPF normal wages;
 *   exemptEpfAdditional  — …that is EPF bonus wages (EPF Bonus 2012);
 *   exemptSocsoWage      — …that is SOCSO/EIS/SKBBK wages.
 */
export type RunStatutoryStamp = {
  epfAdditional: number;
  socsoWageExtra: number;
  epfWageExtra: number;
  exemptEpfWage: number;
  exemptEpfAdditional: number;
  exemptSocsoWage: number;
};
const STAMP_OPTIONAL = ['epfWageExtra', 'exemptEpfWage', 'exemptEpfAdditional', 'exemptSocsoWage'] as const;

/**
 * Read an EARLIER payslip's own stamp (`statutory.statutoryTrace.run.own`), or null when it has none or it
 * does not make sense against the slip's own bonus — the caller then falls back to the gross bonus, which is
 * exactly what every run did before this item, and says so on the trace.
 */
export function readRunStatutoryStamp(statutory: unknown, bonus: number): RunStatutoryStamp | null {
  const st = statutory as { statutoryTrace?: { version?: unknown; run?: { own?: Record<string, unknown> } } } | null;
  const tr = st?.statutoryTrace;
  if (!tr || tr.version !== 1) return null;
  const own = tr.run?.own;
  const epfAdditional = own?.epfAdditional;
  const socsoWageExtra = own?.socsoWageExtra;
  if (typeof epfAdditional !== 'number' || !Number.isFinite(epfAdditional) || epfAdditional < 0) return null;
  if (typeof socsoWageExtra !== 'number' || !Number.isFinite(socsoWageExtra) || socsoWageExtra < 0) return null;
  // The EPF-liable part of a run's additional pay can never exceed the additional pay itself.
  if (epfAdditional > round2(Math.max(0, bonus)) + 0.005) return null;
  const extra = { epfWageExtra: 0, exemptEpfWage: 0, exemptEpfAdditional: 0, exemptSocsoWage: 0 };
  for (const k of STAMP_OPTIONAL) {
    const v = own?.[k];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    extra[k] = v;
  }
  // Both are parts of the same additional pay, so together they can never exceed it either.
  if (round2(epfAdditional + extra.epfWageExtra) > round2(Math.max(0, bonus)) + 0.005) return null;
  return { epfAdditional, socsoWageExtra, ...extra };
}

/**
 * Item 69d6ed3c (follow-up) — WHAT AN EARLIER RUN CHARGED ITS ADDITIONAL PAY ON, whichever record it has.
 *
 *   'trace'           — its own `statutoryTrace.run.own` stamp (payslips processed from this item on);
 *   'component_lines' — a payslip processed BEFORE the trace, read off its own `componentLines` stamp: the
 *                       bonus-bucket money on lines whose EPF box was ticked when THAT run folded them. This is
 *                       the same figure the kernel computes as `bonus − epfAdditionalExcluded`, recorded by that
 *                       run, so reprocessing a later run corrects it without the earlier run being reprocessed
 *                       first. Used only when the lines' bonus buckets add up to the slip's own bonus. Those old
 *                       lines do not record EPF Bonus 2012, so the SOCSO/EIS part stays at the old reading (0);
 *   null              — neither: the caller keeps the old reading (the gross bonus) and discloses it.
 */
export function readEarlierRunLiability(
  statutory: unknown,
  bonus: number,
): (RunStatutoryStamp & { source: 'trace' | 'component_lines' }) | null {
  const own = readRunStatutoryStamp(statutory, bonus);
  if (own) return { ...own, source: 'trace' };
  const lines = (statutory as { componentLines?: unknown } | null)?.componentLines;
  if (!Array.isArray(lines)) return null;
  let total = 0, epf = 0;
  let epfNormal = 0;
  for (const raw of lines) {
    const l = raw as { epf?: unknown; buckets?: unknown; epfNormalStream?: unknown };
    if (!l || typeof l !== 'object' || typeof l.epf !== 'boolean' || !Array.isArray(l.buckets)) return null;
    for (const b of l.buckets as { bucket?: unknown; amount?: unknown }[]) {
      if (b?.bucket !== 'bonus') continue;
      if (typeof b.amount !== 'number' || !Number.isFinite(b.amount)) return null;
      total = round2(total + b.amount);
      // A line stamped `epfNormalStream` (2026-11-13) was NORMAL EPF wages on that run, not bonus EPF wages.
      if (l.epf && l.epfNormalStream === true) epfNormal = round2(epfNormal + b.amount);
      else if (l.epf) epf = round2(epf + b.amount);
    }
  }
  if (Math.abs(total - round2(Math.max(0, bonus))) >= 0.005) return null;
  return {
    epfAdditional: Math.max(0, epf), socsoWageExtra: 0,
    epfWageExtra: Math.max(0, epfNormal), exemptEpfWage: 0, exemptEpfAdditional: 0, exemptSocsoWage: 0,
    source: 'component_lines',
  };
}
