import type { ReactNode } from 'react';
import { Card } from '@/components/ui';
import { payslipPresentationRows, type PayslipPdfData, type PayslipPdfLabels } from '@/lib/payslip-pdf';
import { formatMoney, formatRate } from '@/lib/money';

/** A responsive view over the PDF owner's data and row rules; it computes no payroll values. */
export function PersonalPayslipStatement({data,labels,actions}:{data:PayslipPdfData;labels:PayslipPdfLabels;actions:ReactNode}) {
  const money=(amount:unknown)=>formatMoney(amount,data.currency);
  const unavailable=labels.periodNotRecorded??'—';
  const periodAmount=(amount:number|null|undefined)=>amount==null?unavailable:money(amount);
  const rows=payslipPresentationRows(data,labels,value=>formatRate(value,data.currency));
  const table=(title:string,items:typeof rows.earnings,total?:{label:string;amount:number})=><section className="min-w-0 space-y-2">
    <h3 className="border-b border-border pb-2 text-sm font-semibold">{title}</h3>
    <dl className="divide-y divide-border">{items.map((item,index)=><div key={`${item.label}-${index}`} className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="min-w-0 break-words">{item.label}{item.quantity&&<span className="block text-xs text-muted-foreground">{item.quantity}{item.sub?` × ${item.sub}`:''}</span>}</dt>
      <dd className="shrink-0 text-right tabular-nums">{item.amount==null?item.text??'—':money(item.amount)}</dd>
    </div>)}{total&&<div className="flex justify-between gap-3 py-3 text-sm font-semibold"><dt>{total.label}</dt><dd className="tabular-nums">{money(total.amount)}</dd></div>}</dl>
  </section>;
  const schemes=[['EPF','epf'],['SOCSO','socso'],['EIS','eis'],...(data.hrdf!=null||(data.employerPeriodTotals?.mtd.hrdf??0)>0||(data.employerPeriodTotals?.ytd.hrdf??0)>0?[['HRDF','hrdf']]:[])] as [string,'epf'|'socso'|'eis'|'hrdf'][];
  return <Card className="space-y-6 p-4 sm:p-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="space-y-1"><h2 className="text-xl font-semibold">{data.company}</h2>{data.companyReg&&<p className="text-xs text-muted-foreground">{labels.companyReg}: {data.companyReg}</p>}<p className="text-sm text-muted-foreground">{labels.title} · {labels.periodLabel}</p>{data.payDate&&<p className="text-sm text-muted-foreground">{labels.paymentDateLabel?`${labels.paymentDateLabel}: `:''}{labels.paymentDate}</p>}<p className="text-sm">{[data.employeeCode,data.employee].filter(Boolean).join(' · ')}</p></div>{actions}</header>
    <dl className="grid gap-3 sm:grid-cols-3">{[[labels.grossPay,data.gross],[labels.totalDeductions,data.totalDeductions],[labels.netPay,data.net]].map(([label,value])=><div key={String(label)} className="rounded-lg border border-border p-4"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{money(value)}</dd></div>)}</dl>
    {data.informationRows&&<dl className="grid gap-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-3">{data.informationRows.map((row,index)=><div key={`${row.label}-${index}`}><dt className="text-xs text-muted-foreground">{row.label}</dt><dd className="break-words text-sm">{row.value}</dd></div>)}</dl>}
    <div className="grid gap-6 xl:grid-cols-2">{table(labels.earnings,rows.earnings,{label:labels.totalEarnings,amount:data.gross})}{table(labels.deductions,rows.deductions,{label:labels.totalDeductions,amount:data.totalDeductions})}</div>
    {data.employerBorne.length>0&&<div>{table(labels.employerBorne,data.employerBorne,{label:labels.employerBorneTotal,amount:data.employerBorneTotal})}<p className="text-xs text-muted-foreground">{labels.employerBorneNote}</p></div>}
    <div className="grid gap-6 xl:grid-cols-2">
      <div>{table(labels.employerContributions,schemes.map(([label,key])=>({label,amount:data.employerPeriodTotals?.mtd[key]??undefined,text:unavailable})))}{labels.normalEmployerNote&&<p className="mt-2 text-xs text-muted-foreground">{labels.normalEmployerNote}</p>}</div>
      <section className="min-w-0 space-y-2"><h3 className="border-b border-border pb-2 text-sm font-semibold">{labels.ytdHeading}</h3><div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th scope="col" className="py-2 font-medium">{labels.ytdItem}</th><th scope="col" className="py-2 text-right font-medium">{labels.ytdEmployeeColumn}</th><th scope="col" className="py-2 text-right font-medium">{labels.ytdEmployerColumn}</th></tr></thead><tbody className="divide-y divide-border">{schemes.map(([label,key])=><tr key={key}><th scope="row" className="py-2 text-left font-normal">{label}</th><td className="py-2 text-right tabular-nums">{key==='hrdf'?'':data.ytd?money(data.ytd[key]):unavailable}</td><td className="py-2 text-right tabular-nums">{periodAmount(data.employerPeriodTotals?.ytd[key])}</td></tr>)}{data.ytd&&([[labels.pcb,data.ytd.pcb],[labels.grossPay,data.ytd.gross],[labels.netPay,data.ytd.net]] as const).map(([label,value])=><tr key={label}><th scope="row" className="py-2 text-left font-normal">{label}</th><td className="py-2 text-right tabular-nums">{money(value)}</td><td/></tr>)}</tbody></table></div></section>
    </div>
    {data.configuredEmployerContributions?.length ? table(labels.configuredContributionsHeading??labels.employerContributions,data.configuredEmployerContributions.map(row=>({label:row.name,amount:row.amount}))) : null}
    {data.nonPayableLines?.length ? <div>{table(labels.nonPayable,data.nonPayableLines.map(row=>({label:row.name,amount:row.amount})))}<p className="text-xs text-muted-foreground">{labels.nonPayableNote}</p></div> : null}
    {data.detailNotRecorded&&<p className="text-xs text-muted-foreground">{labels.detailNotRecorded}</p>}
    <div className="space-y-1 border-t border-border pt-4 text-xs text-muted-foreground">{labels.periodScopeNote&&<p>{labels.periodScopeNote}</p>}{labels.hrContactNote&&<p>{labels.hrContactNote}</p>}<p>{labels.generatedNote}</p></div>
  </Card>;
}
