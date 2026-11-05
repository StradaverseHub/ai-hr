'use client';
import {useTranslations} from 'next-intl';
export function DerivedOrganisationPayroll({rows}:{rows:ReadonlyArray<{employmentId:string;name:string;employeeCode:string|null;reason:string}>}){
 const t=useTranslations('derivedOrganisation');if(!rows.length)return null;
 return <section role="alert" className="min-w-0 break-words rounded-lg border border-destructive/40 p-3 text-sm"><h3 className="font-semibold">{t('groupingBlocked')}</h3><p className="text-muted-foreground">{t('groupingHint')}</p><ul className="mt-2 space-y-1">{rows.map(row=><li key={row.employmentId}>{row.employeeCode} · {row.name} — {t(row.reason==='missing_business_unit'?'missingBusinessUnit':'pending')}</li>)}</ul></section>;
}
