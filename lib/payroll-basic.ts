/** Existing payroll basic-pay owners, shared with source-aware formula simulation.
 * These legacy Number boundaries are preserved; the new formula evaluator remains exact decimal. */
const daysInMonth=(year:number,month:number)=>new Date(Date.UTC(year,month,0)).getUTCDate();
const round2=(n:number)=>Math.round(n*100)/100;
export const payrollRateBasic=(rate:number,quantity:number)=>round2(rate*quantity);
export function payrollIncrementBasic(rows:readonly {basic:number;validFrom:string;validTo:string|null}[],periodStart:string,periodEnd:string,dim:number):number|undefined{
 if(rows.length<2)return undefined;
 const ordered=[...rows].sort((a,b)=>a.validFrom.localeCompare(b.validFrom)),old=ordered[0],latest=ordered[ordered.length-1];
 if(latest.validFrom<=periodStart||latest.validFrom>periodEnd)return undefined;
 const before=Math.max(0,Number(latest.validFrom.slice(8,10))-1),after=dim-before;
 return round2((old.basic*before+latest.basic*after)/dim);
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
