import type {CompensationAmendmentHistoryRow} from '../core/comp';
import {formatDmy} from '../lib/date-display';
type Labels={title:string;date:string;amount:string;rate:string;payrollFrom:string;recordOnly:string;reason:string;previous:string;next:string};
/** Display-only HR references. These amounts never replace the paid Salary History rows above. */
export function SalaryAmendmentHistory({rows,page,hasMore,href,labels}:{rows:CompensationAmendmentHistoryRow[];page:number;hasMore:boolean;href:(page:number)=>string;labels:Labels}){
 if(!rows.length&&page===1)return null;
 const amount=(value:string)=>Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
 return <section id="salary-amendments" aria-label={labels.title} className="space-y-3 border-t border-border p-4">
  <div className="overflow-x-auto"><table className="w-full text-left text-sm">
   <caption className="pb-2 text-left font-medium">{labels.title}</caption>
   <thead><tr>{[labels.date,labels.amount,labels.rate,labels.payrollFrom,labels.reason].map(label=><th key={label} scope="col" className="p-2">{label}</th>)}</tr></thead>
   <tbody>{rows.map(row=><tr key={row.id} className="border-t border-border">
    <td className="p-2">{formatDmy(row.effectiveFrom)}</td><td className="p-2 tabular-nums">{row.currency} {amount(row.basicSalary)}</td>
    <td className="p-2 tabular-nums">{row.rateAmount?`${row.currency} ${amount(row.rateAmount)}`:'—'}</td>
    <td className="p-2">{row.payrollFrom?formatDmy(row.payrollFrom):row.informationOnly?labels.recordOnly:'—'}</td><td className="p-2">{row.reason??'—'}</td>
   </tr>)}</tbody>
  </table></div>
  {(page>1||hasMore)&&<nav aria-label={labels.title} className="flex justify-end gap-4 text-sm">
   {page>1&&<a className="underline" href={href(page-1)}>{labels.previous}</a>}{hasMore&&<a className="underline" href={href(page+1)}>{labels.next}</a>}
  </nav>}
 </section>;
}
