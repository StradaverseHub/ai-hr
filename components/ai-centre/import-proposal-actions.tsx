'use client';
/** AI v2 Phase 1, slice 3 (issue 16b) — "Confirm N rows" and "Fix the N rows" on an import prepared in chat.
 *
 * Confirm posts the signed card, with the file sent with its question (components/ai-centre/chat-import-attach.tsx),
 * to its owner (app/assistant/chat-import-actions.ts), which verifies both for this caller and commits through the import
 * owner's own path; nothing posts without a press, and a second press is answered with the first outcome. Fix opens the
 * kind's import page with this same file handed over in this tab's memory (components/assistant/import-handoff.tsx), so
 * the page's own preview lists every row; without the file it opens the page.
 *
 * AI v2 Phase 2 P2-6: like the other cards prepared in chat, the card posts one learning signal for its turn
 * (app/assistant/learning-actions.ts) after an import the owner accepted (confirmed), after Fix or Open the import page
 * (edited), or after Discard, which closes the card and imports nothing. Never waited on; it changes nothing on the card. */
import {useContext,useState} from 'react';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button} from '@/components/ui/button';
import {confirmChatImportAction} from '@/app/assistant/chat-import-actions';
import {recordCardSignalAction} from '@/app/assistant/learning-actions';
import type {ChatImportConfirmResult} from '@/core/chat-import/confirm';
import type {Proposal} from '@/core/proposals/proposal';
import {CHAT_IMPORT_HANDOFF,CHAT_IMPORT_PAGES,isChatImportKind} from '@/lib/chat-import';
import {internalHref} from '@/lib/ai-centre/inline-proposal';
import {useAssistantImportHandoff} from '@/components/assistant/import-handoff';
import {TurnImportFile} from './chat-import-attach';

const REFUSED:Readonly<Record<string,string>>=Object.freeze({expired:'expired',authority_mismatch:'access',authority_unsupported:'access',not_permitted:'access',
 file_changed:'file',changed:'changed',not_confirmable:'notConfirmable',in_progress:'inProgress',malformed:'invalid',signature:'invalid',not_yet_valid:'invalid',wrong_action:'invalid',not_confirmed:'invalid'});

export function ImportProposalActions({proposal,turnId}:{proposal:Proposal;turnId?:string}){
 const t=useTranslations('chatImport'),router=useRouter(),file=useContext(TurnImportFile),handoff=useAssistantImportHandoff();
 const summary=proposal.body.import!,kind=summary.kind,page=isChatImportKind(kind)?CHAT_IMPORT_PAGES[kind]:'/assistant';
 const [busy,setBusy]=useState(false),[result,setResult]=useState<ChatImportConfirmResult|null>(null),[failed,setFailed]=useState(false),[discarded,setDiscarded]=useState(false);
 const learn=(signal:'card_confirmed'|'card_edited'|'card_discarded')=>{if(!turnId)return;try{void recordCardSignalAction({proposal,turnId,signal}).catch(()=>undefined);}catch{/* learning never changes the card */}};
 async function confirm(){
  if(busy)return;setBusy(true);setFailed(false);
  try{const outcome=await confirmChatImportAction({proposal,confirm:true,...(kind==='payroll_history'||!file?{}:{file:{name:file.name,format:file.format,text:file.text}})});
   setResult(outcome);if(outcome.kind==='imported')learn('card_confirmed');}
  catch{setFailed(true);}finally{setBusy(false);}
 }
 function fix(){
  learn('card_edited');
  if(file&&handoff&&isChatImportKind(kind)){const nonce=handoff.put(CHAT_IMPORT_HANDOFF[kind],file.text);router.push(page+'?assistantImport='+encodeURIComponent(nonce));return;}
  router.push(page);
 }
 if(discarded)return <p role="status" data-chat-import-outcome="discarded" className="text-sm text-muted-foreground">{t('discarded')}</p>;
 if(result?.kind==='imported'){
  const history=internalHref(result.historyHref),otherCompany=result.otherCompany??0,leftOut=Math.max(0,result.notImported-otherCompany);
  return <div role="status" data-chat-import-outcome="imported" className="space-y-1 text-sm">
   <p className="font-medium">{result.replayed?t('replayed'):t('done',{count:result.imported})}{leftOut>0&&<> {t('doneLeftOut',{count:leftOut})}</>}
    {otherCompany>0&&<> {t('otherCompany',{count:otherCompany})}</>}</p>
   {history&&<Link href={history} className="inline-flex items-center text-sm font-medium text-primary underline underline-offset-2 hover:no-underline pointer-coarse:min-h-11">{result.revertible?t('historyRevert'):t('history')}</Link>}
  </div>;
 }
 const refusal=result?.kind==='refused'?REFUSED[result.reason]??'unavailable':failed?'unavailable':null;
 return <div className="space-y-2">
  <div role="group" aria-label={t('actionsLabel')} className="flex flex-wrap items-center gap-2">
   {summary.confirmable&&summary.ready>0&&<Button type="button" onClick={()=>void confirm()} disabled={busy} aria-busy={busy} data-chat-import-confirm className="pointer-coarse:min-h-11">
    {busy?t('confirming'):t('confirm',{count:summary.ready})}</Button>}
   {summary.attention>0
    ?<Button aria-busy={busy} type="button" variant="outline" onClick={fix} disabled={busy} data-chat-import-fix className="pointer-coarse:min-h-11">{t('fix',{count:summary.attention})}</Button>
    :<Button aria-busy={busy} type="button" variant="outline" onClick={()=>{learn('card_edited');router.push(page);}} disabled={busy} className="pointer-coarse:min-h-11">{t('openPage')}</Button>}
   <Button aria-busy={busy} type="button" variant="ghost" onClick={()=>{learn('card_discarded');setDiscarded(true);}} disabled={busy} data-chat-import-discard className="text-muted-foreground pointer-coarse:min-h-11">{t('discard')}</Button>
  </div>
  {refusal&&<p role="alert" className="text-sm text-destructive">{t('refused.'+refusal)}</p>}
 </div>;
}
