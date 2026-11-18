/** Credit status is decided from its own lot, never from an employee-wide running balance. */
export const CREDIT_REGISTER_STATUSES = ['available','partially_used','fully_used','expired','reversed','paid_out'] as const;
export type CreditRegisterStatus = typeof CREDIT_REGISTER_STATUSES[number];
export function creditRegisterFigures(p:{earned:number;taken:number;state:'active'|'taken'|'converted_to_pay'|'lapsed'|'reversed';expiresOn:string;today:string}) {
  const earned=Math.round(p.earned*100),used=Math.round(p.taken*100),remaining=Math.max(0,earned-used);
  const status:CreditRegisterStatus=p.state==='reversed'?'reversed':p.state==='converted_to_pay'?'paid_out':remaining===0?'fully_used':p.state==='lapsed'||p.expiresOn<p.today?'expired':used>0?'partially_used':'available';
  return {earned:earned/100,used:used/100,available:status==='available'||status==='partially_used'?remaining/100:0,expired:status==='expired'?remaining/100:0,status,reversible:status==='available'&&used===0};
}
export type CreditUsageDate={requestId:string;date:string;days:number};
/** Existing request-to-lot events own the amounts. Approved date rows only describe that allocation.
 * After a partial cancellation, project the remaining net lot allocations over surviving dates in order.
 * A date is never invented for legacy requests that did not retain a date allocation. */
export function projectCreditUsage(lots:{accrualId:string;days:number}[],dates:CreditUsageDate[]) {
  const out=new Map<string,CreditUsageDate[]>();
  let index=0,remaining=dates.length?Math.round(dates[0].days*100):0;
  for(const lot of lots){
    let need=Math.max(0,Math.round(lot.days*100));
    const rows:CreditUsageDate[]=[];
    while(need>0&&index<dates.length){
      const take=Math.min(need,remaining);
      if(take>0)rows.push({...dates[index],days:take/100});
      need-=take;remaining-=take;
      if(remaining===0){index++;remaining=index<dates.length?Math.round(dates[index].days*100):0;}
    }
    out.set(lot.accrualId,rows);
  }
  return out;
}

/** Immutable command provenance only. Invalid or incomplete snapshots remain unattributed. */
export function frozenCreditDates(value: unknown): {date: string; days: number}[] | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as {version?: unknown; totalDays?: unknown; dates?: unknown};
  if (snapshot.version !== 1 || typeof snapshot.totalDays !== 'number' || !Number.isFinite(snapshot.totalDays)
    || snapshot.totalDays <= 0 || !Array.isArray(snapshot.dates) || !snapshot.dates.length || snapshot.dates.length > 400) return null;
  const dates: {date: string; days: number}[] = [], seen = new Set<string>();
  for (const row of snapshot.dates) {
    if (!row || typeof row !== 'object' || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
      || !Number.isFinite(Date.parse(row.date+'T00:00:00Z')) || new Date(row.date+'T00:00:00Z').toISOString().slice(0,10) !== row.date
      || seen.has(row.date) || typeof row.days !== 'number' || !Number.isFinite(row.days) || row.days <= 0 || row.days > 1) return null;
    seen.add(row.date); dates.push({date: row.date, days: row.days});
  }
  if (dates.reduce((sum,row) => sum+Math.round(row.days*100),0) !== Math.round(snapshot.totalDays*100)) return null;
  return dates.sort((a,b) => a.date.localeCompare(b.date));
}
