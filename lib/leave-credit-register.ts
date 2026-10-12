/** Credit status is decided from its own lot, never from an employee-wide running balance. */
export const CREDIT_REGISTER_STATUSES = ['available','partially_used','fully_used','expired','reversed','paid_out'] as const;
export type CreditRegisterStatus = typeof CREDIT_REGISTER_STATUSES[number];
export function creditRegisterFigures(p:{earned:number;taken:number;state:string;expiresOn:string;today:string}) {
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
