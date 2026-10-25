import {getLocale,getTranslations} from 'next-intl/server';
import type {SessionContext} from '@/db/client';
import {isGroupAdmin} from '@/lib/authz-model';
import {Card} from '@/components/ui';
import {readHomeCardInteractions} from '@/core/employee-home-analytics';
/** Tenant-wide anonymous totals require current group authority at the SQL boundary as well. */
export async function HomeUsageSummary({session}:{session:SessionContext}){
 if(!isGroupAdmin(session))return null;
 const [t,names,locale]=await Promise.all([getTranslations('employeeHome.usage'),getTranslations('employeeHome.cardNames'),getLocale()]);
 const rows=await readHomeCardInteractions(session).catch(()=>null),number=new Intl.NumberFormat(locale);
 return <Card className="space-y-4 p-5"><h3 className="font-semibold">{t('title')}</h3>
  <p className="max-w-prose text-sm text-muted-foreground">{t('intro')}</p>
  {rows?<div className="overflow-x-auto"><table className="w-full text-sm"><caption className="pb-3 text-left text-xs text-muted-foreground">{t('privacy')}</caption>
   <thead><tr className="border-b"><th scope="col" className="py-3 text-left font-medium">{t('card')}</th><th scope="col" className="px-3 py-3 text-right font-medium">{t('views')}</th><th scope="col" className="py-3 text-right font-medium">{t('clicks')}</th></tr></thead>
   <tbody>{rows.map(row=><tr key={row.card} className="border-b last:border-0"><th scope="row" className="py-3 text-left font-normal">{names(row.card)}</th><td className="px-3 py-3 text-right tabular-nums">{number.format(row.views)}</td><td className="py-3 text-right tabular-nums">{number.format(row.clicks)}</td></tr>)}</tbody>
  </table></div>:<p role="status" className="text-sm text-muted-foreground">{t('failed')}</p>}
 </Card>;
}
