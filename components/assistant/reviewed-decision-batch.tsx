'use client';
/** Human-only composition of existing guarded browser commands. There is no batch service,
 * shared transaction, new authority, model input, select-all or automatic confirmation/retry. */
import {useCallback,useEffect,useRef,useState} from 'react';
import {useTranslations} from 'next-intl';
import {z} from 'zod';
import {Button} from '@/components/ui';
import {ASSIGNED_DECISION_CONTRACTS,type AssignedDecisionAction} from '@/lib/assistant-actions/assigned-decision-contract';
import {REVIEWED_LEAVE_DECISION_ACTION} from '@/lib/assistant-actions/reviewed-leave-decision-contract';
import {AssignedLeaveActionChoices,AssignedLeaveModuleActionBrowserPacket} from '@/lib/assistant-actions/module-action-http';
import {checkGenericPacket,sendGenericModuleAction} from './generic-module-action-transport';
import {ModuleAssignedLeaveActionPanel,readModuleAssignedLeaveActionResponse} from './module-assigned-leave-action-panel';
import {AssignedDecisionPanel} from './assigned-decision-panel';
import {ReviewedDecisionBatchContext,type SelectedDecision} from './reviewed-decision-batch-context';
export const REVIEWED_DECISION_BATCH_LIMIT=20;
type Action=AssignedDecisionAction|typeof REVIEWED_LEAVE_DECISION_ACTION;
const IndexRow=z.object({actionId:z.guid(),state:z.string(),expiresAt:z.iso.datetime()}).passthrough();
export function ReviewedDecisionBatch({action,leaveChoices}:{action:Action;leaveChoices:z.infer<typeof AssignedLeaveActionChoices>}){
 const t=useTranslations('assistant.workspace.bulkDecisions');
 const [rows,setRows]=useState<string[]|null>(null),[selected,setSelected]=useState<Map<string,SelectedDecision>>(()=>new Map()),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(false),[finished,setFinished]=useState(false);
 const flight=useRef(false),alive=useRef(true),controller=useRef<AbortController|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
 const register=useCallback((entry:SelectedDecision)=>{setSelected(previous=>new Map(previous).set(entry.actionId,entry));return()=>setSelected(previous=>{if(previous.get(entry.actionId)!==entry)return previous;const next=new Map(previous);next.delete(entry.actionId);return next;});},[]);
 async function load(){
  if(flight.current)return;flight.current=true;setLoading(true);setError(false);setFinished(false);setRows(null);setSelected(new Map());const abort=new AbortController();controller.current=abort;const timer=setTimeout(()=>abort.abort(),15000);
  try{let result:unknown;
   if(action===REVIEWED_LEAVE_DECISION_ACTION){const packet=AssignedLeaveModuleActionBrowserPacket.parse({action,operation:'list'}),response=await fetch('/api/assistant/module-actions',{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',redirect:'error',signal:abort.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify(packet)});result=await readModuleAssignedLeaveActionResponse(response,packet);}
   else{const packet=checkGenericPacket({action,operation:'list'});if(!packet)throw Error();result=ASSIGNED_DECISION_CONTRACTS[action].Index.parse(await sendGenericModuleAction(packet,abort.signal));}
   const index=z.object({reviews:z.array(IndexRow).max(25)}).passthrough().parse(result);
   if(alive.current&&!abort.signal.aborted)setRows(index.reviews.filter(row=>row.state==='awaiting_confirmation'&&Date.parse(row.expiresAt)>Date.now()).slice(0,REVIEWED_DECISION_BATCH_LIMIT).map(row=>row.actionId));
  }catch{if(alive.current)setError(true);}finally{clearTimeout(timer);flight.current=false;controller.current=null;if(alive.current)setLoading(false);}
 }
 async function confirmSelected(){
  if(flight.current||selected.size===0||selected.size>REVIEWED_DECISION_BATCH_LIMIT)return;
  const snapshot=[...selected.values()];if(snapshot.some(row=>Date.now()>=Date.parse(row.expiresAt))){setSelected(new Map());setError(true);return;}
  flight.current=true;setBusy(true);setError(false);setFinished(false);
  try{for(const row of snapshot){if(!alive.current)break;await row.confirm();}}finally{flight.current=false;if(alive.current){setBusy(false);setSelected(new Map());setFinished(true);}}
 }
 return <section className="space-y-6" aria-label={t('title')} aria-busy={busy||loading}>
  <div className="max-w-prose space-y-2"><h2 className="text-lg font-semibold">{t('title')}</h2><p className="text-sm text-muted-foreground">{t('intro')}</p><p className="text-sm text-muted-foreground">{t('scope')}</p></div>
  <Button type="button" className="min-h-11 h-auto max-w-full whitespace-normal break-words" variant="outline" disabled={busy||loading} onClick={()=>void load()}>{t(loading?'loading':'load')}</Button>
  {error&&<p role="alert" className="text-sm">{t('unavailable')}</p>}
  {rows?.length===0&&<p role="status" className="text-sm">{t('none')}</p>}
  <ReviewedDecisionBatchContext.Provider value={{busy,register}}>
   {rows&&rows.length>0&&<ol className="space-y-6">{rows.map(id=><li key={id} className="border-b border-border pb-6">{action===REVIEWED_LEAVE_DECISION_ACTION?<ModuleAssignedLeaveActionPanel choices={leaveChoices} resumeActionId={id}/>:<AssignedDecisionPanel action={action} resumeActionId={id}/>}</li>)}</ol>}
  </ReviewedDecisionBatchContext.Provider>
  {rows&&rows.length>0&&<div className="space-y-2"><Button type="button" className="min-h-11 h-auto max-w-full whitespace-normal break-words py-2" disabled={busy||selected.size===0} onClick={()=>void confirmSelected()}>{t(busy?'working':'confirm',{count:selected.size})}</Button><p className="max-w-prose text-xs text-muted-foreground">{t('independent')}</p></div>}
  {finished&&<p role="status" className="text-sm">{t('finished')}</p>}
 </section>;
}
