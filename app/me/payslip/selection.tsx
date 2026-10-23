'use client';
import { useState } from 'react';
import { Button, inputCls } from '@/components/ui';

export type PersonalPayslipChoice = {
  payslipId:string; companyId:string; company:string; payPeriod:string; label:string;
};
export function PersonalPayslipSelection({runs,selectedId,labels}:{
  runs:PersonalPayslipChoice[]; selectedId:string|null;
  labels:{company:string;year:string;month:string;cycle:string;view:string;unavailable:string;help:string;months:string[]};
}) {
  const [id,setId]=useState(selectedId ?? '');
  const selected=runs.find(run=>run.payslipId===id);
  const companies=[...new Map(runs.map(run=>[run.companyId,run.company])).entries()];
  const inCompany=runs.filter(run=>run.companyId===selected?.companyId);
  const years=[...new Set(inCompany.map(run=>run.payPeriod.slice(0,4)))].sort().reverse();
  const inYear=inCompany.filter(run=>run.payPeriod.slice(0,4)===selected?.payPeriod.slice(0,4));
  const months=[...new Set(inYear.map(run=>run.payPeriod.slice(5,7)))].sort();
  const inMonth=inYear.filter(run=>run.payPeriod===selected?.payPeriod);
  const choose=(pool:PersonalPayslipChoice[])=>setId(pool[0]?.payslipId ?? '');
  return <form method="GET" className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="space-y-1 text-sm font-medium">{labels.company}<select className={inputCls} name="companyId" value={selected?.companyId ?? ''} onChange={event=>choose(runs.filter(run=>run.companyId===event.target.value))}>
        {!selected&&<option value="">{labels.unavailable}</option>}{companies.map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="space-y-1 text-sm font-medium">{labels.year}<select className={inputCls} name="year" value={selected?.payPeriod.slice(0,4) ?? ''} onChange={event=>choose(inCompany.filter(run=>run.payPeriod.slice(0,4)===event.target.value))}>
        {!selected&&<option value="">—</option>}{years.map(year=><option key={year} value={year}>{year}</option>)}
      </select></label>
      <label className="space-y-1 text-sm font-medium">{labels.month}<select className={inputCls} name="month" value={selected?.payPeriod.slice(5,7) ?? ''} onChange={event=>choose(inYear.filter(run=>run.payPeriod.slice(5,7)===event.target.value))}>
        {!selected&&<option value="">—</option>}{months.map(month=><option key={month} value={month}>{labels.months[Number(month)-1]}</option>)}
      </select></label>
      <label className="space-y-1 text-sm font-medium">{labels.cycle}<select className={inputCls} name="payslipId" value={id} onChange={event=>setId(event.target.value)}>
        {!selected&&<option value="">—</option>}{inMonth.map(run=><option key={run.payslipId} value={run.payslipId}>{run.label}</option>)}
      </select></label>
    </div>
    <div className="flex flex-wrap items-center gap-3"><Button type="submit" disabled={!selected} className="min-h-11">{labels.view}</Button><p className="text-xs text-muted-foreground">{labels.help}</p></div>
  </form>;
}
