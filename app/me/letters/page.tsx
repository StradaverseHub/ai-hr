import Link from 'next/link';
import {redirect} from 'next/navigation';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {getLocale,getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {listMyLetters} from '@/core/letters';
import {Card,PageHeader,pageWideCls} from '@/components/ui';
export const dynamic='force-dynamic';
export default async function MyLettersPage({searchParams}:{searchParams:Promise<{cursor?:string;error?:string}>}){
 await requireModule('employees');const {s}=await scopedSession(),sp=await searchParams,t=await getTranslations('letters.mine'),locale=await getLocale();
 const list=await listMyLetters(s,{cursor:sp.cursor}).catch(error=>{if(sp.cursor&&error instanceof LetterWorkflowError&&['permission','invalid'].includes(error.code))redirect('/me/letters?error=invalid');throw error;}),date=(value:Date|null)=>value?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(value):t('unavailable');
 return <div className={pageWideCls}><PageHeader title={t('title')} description={t('description')}/>{sp.error&&<p role="alert" className="rounded-md border border-destructive p-4 text-sm text-destructive">{t('errors.invalid')}</p>}{list.rows.length===0?<Card className="p-6 text-sm text-muted-foreground">{t('empty')}</Card>:<ul className="space-y-3">{list.rows.map(letter=><li key={letter.id}><Card className="flex flex-wrap items-center justify-between gap-4 p-4"><div className="min-w-0 space-y-1"><Link href={'/me/letters/'+letter.id} className="break-words font-semibold text-primary underline-offset-4 hover:underline">{letter.reference}</Link><p className="text-sm text-muted-foreground">{t('issuedOn',{date:date(letter.issuedAt)})}</p><p className="text-sm">{letter.state==='void'?t('void'):letter.confirmed==='signed'?t('signed'):letter.confirmed?t('acknowledged'):letter.viewed?t('viewed'):t('new')}</p>{letter.state==='issued'&&letter.acknowledgement!=='none'&&!letter.confirmed&&<p className="text-sm text-muted-foreground">{t('pendingAcknowledgement')}</p>}</div><Link href={'/me/letters/'+letter.id} className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">{t('details')}</Link></Card></li>)}</ul>}{list.nextCursor&&<Link href={'/me/letters?cursor='+list.nextCursor} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline">{t('next')}</Link>}</div>;
}
