import Link from 'next/link';
import {getTranslations} from 'next-intl/server';
import {Card} from '@/components/ui';

/** AI v2 W11 — where people find the protected case route (ADR-0173). Static links: neither card reads a case, a
 * handler or anything else, so they can sit on pages every person or administrator opens. */
const linkCls='inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline';

/** My Profile: a person's own private cases with HR. */
export async function PrivateCaseEntryCard(){
 const t=await getTranslations('privateCases');
 return <Card className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0"><p className="text-sm font-medium">{t('entry.title')}</p>
  <p className="mt-1 text-xs text-muted-foreground">{t('entry.help')}</p></div><Link href="/me/cases" className={linkCls}>{t('entry.open')}</Link></Card>;
}

/** Data privacy: the administrators' designation of case handlers. */
export async function PrivateCaseHandlersCard(){
 const t=await getTranslations('privateCases');
 return <Card className="flex flex-wrap items-center justify-between gap-3 p-4"><div className="min-w-0"><h2 className="text-sm font-semibold">{t('privacyCard.title')}</h2>
  <p className="mt-1 text-sm text-muted-foreground">{t('privacyCard.help')}</p></div><Link href="/admin/privacy/case-handlers" className={linkCls}>{t('privacyCard.link')}</Link></Card>;
}
