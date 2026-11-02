/** Existing payroll basic-pay owners, shared with source-aware formula simulation.
 * These legacy Number boundaries are preserved; the new formula evaluator remains exact decimal. */
const daysInMonth=(year:number,month:number)=>new Date(Date.UTC(year,month,0)).getUTCDate();
const round2=(n:number)=>Math.round(n*100)/100;
export const payrollRateBasic=(rate:number,quantity:number)=>round2(rate*quantity);
/** Blend every effective half-open salary interval across a complete calendar month.
 * A missing/overlapping day is not enough evidence to replace the ordinary basic-pay owner.
 * Tenure, custom cutoffs and policy divisors remain the caller's separate proration contract.
 */
export function payrollIncrementBasic(
  rows: readonly { basic: number; validFrom: string; validTo: string | null }[],
  periodStart: string,
  periodEnd: string,
  dim: number,
): number | undefined {
  const effective = rows.filter(row => row.validFrom <= periodEnd && (!row.validTo || row.validTo > periodStart));
  if (effective.length < 2) return undefined;
  let total = 0;
  for (let time = Date.parse(`${periodStart}T00:00:00Z`); time <= Date.parse(`${periodEnd}T00:00:00Z`); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    const active = effective.filter(row => row.validFrom <= day && (!row.validTo || row.validTo > day));
    if (active.length !== 1 || !Number.isFinite(active[0].basic)) return undefined;
    total += active[0].basic;
  }
  return round2(total / dim);
}
export function eligibleWorkingDays(
  payPeriod: string,
  hiredOn: string,
  terminatedOn: string | null,
  holidays: Set<string>,
): number {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = `${payPeriod}-01`;
  const periodEnd = `${payPeriod}-${String(dim).padStart(2, '0')}`;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return 0;
  let days = 0;
  for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const iso = ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
    if (iso <= 5 && !holidays.has(d)) days++;
  }
  return days;
}


export const payrollRoundAmount = (n: number, method?: string | null): number => {
  switch (method) {
    case 'up':
      return Math.ceil(round2(n));
    case 'down':
      return Math.floor(round2(n));
    case 'nearest':
      return Math.round(round2(n));
    default:
      return round2(n);
  }
};
