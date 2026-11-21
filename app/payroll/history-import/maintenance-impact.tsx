'use client';
import {useTranslations} from 'next-intl';
import type {PayrollHistoryMaintenanceImpact} from '@/lib/payroll-history-maintenance';
/** Counted categories are structured service facts. A named refusal remains the owner's detail. */
export function HistoryMaintenanceImpacts({items}:{items:PayrollHistoryMaintenanceImpact[]}){
 const t=useTranslations('payrollHistoryMaintenance');
 if(!items.length)return null;
 return <ul className="space-y-2 text-sm">{items.map((item,index)=><li key={index} className="break-words">{typeof item.count==='number'?t('impactKinds.'+item.kind,{count:item.count}):item.message}</li>)}</ul>;
}
