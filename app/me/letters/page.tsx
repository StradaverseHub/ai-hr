import Link from 'next/link';
import {redirect} from 'next/navigation';
import {LetterWorkflowError} from '@/lib/letter-workflow';
import {getLocale,getTranslations} from 'next-intl/server';
import {requireModule} from '@/lib/authz';
import {scopedSession} from '@/lib/scope';
import {listMyLetters} from '@/core/letters';
import {listMyLetterRequests,listRequestableLetterTypes,type OwnLetterRequest} from '@/core/letter-requests';
import {Card,PageHeader,StatusBadge,btnPrimary,pageWideCls} from '@/components/ui';
import {LetterRequestForm} from '@/components/letters/letter-requests';
import {requestLetterAction} from './actions';
export const dynamic='force-dynamic';
const REQUEST_ERRORS=['invalid','not_requestable','duplicate','unavailable'] as const;
/** AI v2 Phase 1 slice 3: the person's own letter requests and their status sit above their issued letters. "Request a
 * letter" appears only when their company has opened a letter type for employee requests; it opens the small request form
 * on this page (`?request=1`, with `template` from the chat card's Edit). A request source that fails leaves the letters
 * list in place with one sentence. */
const settle=<T,>(promise:Promise<T>)=>promise.then(value=>({ok:true as const,value}),()=>({ok:false as const}));
export default async function MyLettersPage({searchParams}:{searchParams:Promise<{cursor?:string;error?:string;notice?:string;request?:string;template?:string;requestError?:string}>}){
 await requireModule('employees');const {s}=await scopedSession(),sp=await searchParams,t=await getTranslations('letters.mine'),locale=await getLocale();
 const [list,requests,requestable]=await Promise.all([
  listMyLetters(s,{cursor:sp.cursor}).catch(error=>{if(sp.cursor&&error instanceof LetterWorkflowError&&['permission','invalid'].includes(error.code))redirect('/me/letters?error=invalid');throw error;}),
  settle(listMyLetterRequests(s)),settle(listRequestableLetterTypes(s))]);
 const date=(value:Date|null)=>value?new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeZone:'Asia/Kuala_Lumpur'}).format(value):t('unavailable');
 const types=requestable.ok?requestable.value:[],asking=sp.request==='1';
 const requestError=REQUEST_ERRORS.find(code=>code===sp.requestError);
 const requestCard=(request:OwnLetterRequest)=><li key={request.id}><Card className="flex flex-wrap items-center justify-between gap-4 p-4" data-letter-request={request.status}>
  <div className="min-w-0 space-y-1"><p className="break-words font-semibold">{request.letterTypeName}</p>
   <p className="text-sm text-muted-foreground">{t('requests.requestedOn',{date:date(request.createdAt)})}</p></div>
  <div className="flex flex-wrap items-center gap-3"><StatusBadge status={'letter_request_'+request.status} label={t(`requests.status.${request.status}`)}/>
   {request.letterId&&<Link href={'/me/letters/'+request.letterId} className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">{t('requests.openLetter')}</Link>}</div>
  {request.status==='declined'&&request.employeeMessage&&<p data-letter-request-message className="basis-full whitespace-pre-line break-words rounded-md bg-muted p-3 text-sm"><span className="font-medium">{t('requests.messageFromHr')}:</span> {request.employeeMessage}</p>}
 </Card></li>;
 return <div className={pageWideCls}><PageHeader title={t('title')} description={t('description')}
  actions={types.length>0&&!asking?<Link href="/me/letters?request=1#request-letter" className={`${btnPrimary} inline-flex min-h-11 items-center`}>{t('requests.request')}</Link>:undefined}/>
  {sp.notice==='requested'&&<p role="status" className="rounded-md border p-4 text-sm">{t('requests.sent')}</p>}
  {sp.error&&<p role="alert" className="rounded-md border border-destructive p-4 text-sm text-destructive">{t('errors.invalid')}</p>}
  {asking&&(types.length>0
   ?<LetterRequestForm types={types} preselect={sp.template} action={requestLetterAction} labels={{title:t('requests.formTitle'),description:t('requests.formDescription'),
     type:t('requests.type'),choose:t('requests.choose'),typeInCompany:(type,company)=>t('requests.typeInCompany',{type,company}),purpose:t('requests.purpose'),
     purposeHelp:t('requests.purposeHelp'),submit:t('requests.submit'),cancel:t('requests.cancel'),error:requestError?t(`requests.errors.${requestError}`):null}}/>
   :<Card role="note" className="p-4 text-sm text-muted-foreground">{requestable.ok?t('requests.none'):t('requests.unavailable')}</Card>)}
  {!requests.ok?<p role="note" className="text-sm text-muted-foreground">{t('requests.unavailable')}</p>
   :requests.value.length>0&&<section className="space-y-3" aria-labelledby="my-letter-requests"><h2 id="my-letter-requests" className="font-semibold">{t('requests.title')}</h2>
    <ul className="space-y-3">{requests.value.map(requestCard)}</ul></section>}
  {list.rows.length===0?<Card className="p-6 text-sm text-muted-foreground">{t('empty')}</Card>:<ul className="space-y-3">{list.rows.map(letter=><li key={letter.id}><Card className="flex flex-wrap items-center justify-between gap-4 p-4"><div className="min-w-0 space-y-1"><Link href={'/me/letters/'+letter.id} className="break-words font-semibold text-primary underline-offset-4 hover:underline">{letter.reference}</Link><p className="text-sm text-muted-foreground">{t('issuedOn',{date:date(letter.issuedAt)})}</p><p className="text-sm">{letter.state==='void'?t('void'):letter.confirmed==='signed'?t('signed'):letter.confirmed?t('acknowledged'):letter.viewed?t('viewed'):t('new')}</p>{letter.state==='issued'&&letter.acknowledgement!=='none'&&!letter.confirmed&&<p className="text-sm text-muted-foreground">{t('pendingAcknowledgement')}</p>}</div><Link href={'/me/letters/'+letter.id} className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">{t('details')}</Link></Card></li>)}</ul>}{list.nextCursor&&<Link href={'/me/letters?cursor='+list.nextCursor} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline">{t('next')}</Link>}</div>;
}
