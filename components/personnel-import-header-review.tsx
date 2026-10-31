/** Client-local header review. No provider/action/storage/commit import; sample values never leave
 * this component's browser memory. The parent applies a new revision then requires fresh validation. */
'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {Button,inputCls} from './ui';
import {personnelHeaderSuggestions,preparePersonnelHeaderAssistancePacket,type PersonnelImportSource} from '@/lib/personnel-import-assistance-source';
import {z} from 'zod';
import {EmployeeImportEvaluationBindingSchema,type EmployeeImportEvaluationBinding} from '@/lib/personnel-import-evaluation';
import {capturePersonnelImportHeaders,capturePersonnelImportHeaderProposal,type PersonnelImportHeaderProposal} from '@/lib/personnel-import-assistance';
import {preparePersonnelImportHeadersAction,assistPersonnelImportHeadersAction,reopenPersonnelImportHeadersAction} from '@/app/(app)/admin/personnel/import/assistance-actions';
import type {PersonnelImportHeaderOptions} from '@/lib/personnel-import-contract';
export type PersonnelImportHeaderAssistanceAnnotation=Readonly<{attemptId:string;attemptVersion:number;adoptedMappings:number}>;
export type PersonnelImportHeaderReviewMessages=Readonly<{title:string;localOnly:string;sheet:string;column:string;sourceHeading:string;sampleValues:string;destination:string;chooseField:string;unresolved:string;ambiguous:string;duplicate:string;applyMapping:string;cancel:string;reviewHeadings:string;invalidSource:string;acceptedRevision:string;sourceChanged:string;unknownSheet:string;aiTitle:string;aiDescription:string;aiChoose:string;aiConsent:string;aiSend:string;aiWorking:string;aiUnavailable:string;aiUncertain:string;aiReopen:string;aiNewRequest:string;aiReady:string;aiUseSuggestion:string;aiNoHeadings:string;aiLimit:string;aiSelected:string;aiStale:string;aiPrepareUnknown:string;}>;
export function PersonnelImportHeaderReview({source,companyId,options,choices,messages,onApply,onCancel,disabled=false,evaluationBinding,allowAi=true}:{source:PersonnelImportSource;companyId:string;options:PersonnelImportHeaderOptions;choices:readonly {key:string;label:string}[];messages:PersonnelImportHeaderReviewMessages;onApply:(destinations:readonly string[],revisionId:string,assistance?:PersonnelImportHeaderAssistanceAnnotation)=>void;onCancel:()=>void;disabled?:boolean;evaluationBinding?:EmployeeImportEvaluationBinding;allowAi?:boolean}){
 const id=useId(),suggestions=personnelHeaderSuggestions(source,options);
 const [selected,setSelected]=useState(()=>source.acceptedDestinations?[...source.acceptedDestinations]:suggestions.map(row=>row.matches.length===1?row.matches[0]:''));
 const [aiColumns,setAiColumns]=useState<number[]>([]),[consented,setConsented]=useState(false),[aiPending,setAiPending]=useState(false);
 const [aiStatus,setAiStatus]=useState<'idle'|'unavailable'|'uncertain'|'ready'|'stale'>('idle');
 type Packet=Awaited<ReturnType<typeof preparePersonnelHeaderAssistancePacket>>;
 type Saved={packet:Packet;localRevision:string;companyId:string;evaluationKey:string;indexes:Map<number,number>;binding?:{attemptId:string;attemptVersion:number}};
 const saved=useRef<Saved|null>(null),pending=useRef(false),alive=useRef(true),latest=useRef({revision:source.revisionId,companyId,evaluationKey:JSON.stringify(evaluationBinding)});
 latest.current={revision:source.revisionId,companyId,evaluationKey:JSON.stringify(evaluationBinding)};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const [proposal,setProposal]=useState<{value:PersonnelImportHeaderProposal;saved:Saved}|null>(null);
 const [adopted,setAdopted]=useState<{attemptId:string;attemptVersion:number;fields:Record<number,string>}|null>(null);
 useEffect(()=>{setAdopted(null);},[source.revisionId,companyId]);
 const originalIndex=(index:number)=>(source.provenance?.rows[0]?.cells[index]?.column??index+1)-1;
 const eligible=suggestions.filter(row=>row.matches.length!==1);
 let reviewedHeaders:ReturnType<typeof capturePersonnelImportHeaders>|null=null;
 try{if(aiColumns.length)reviewedHeaders=capturePersonnelImportHeaders(eligible.filter(row=>aiColumns.includes(row.index)).map(row=>({columnIndex:originalIndex(row.index),heading:row.raw})));}catch{/* Manual review remains available; no truncation or partial packet. */}
 const current=(request:Saved)=>alive.current&&latest.current.revision===request.localRevision&&latest.current.companyId===request.companyId&&latest.current.evaluationKey===request.evaluationKey;
 const requestAssistance=async(reopen:boolean)=>{
  if(pending.current||disabled||!allowAi)return;
  if(!reopen&&(!consented||!reviewedHeaders||reviewedHeaders.length>32||saved.current))return;
  const localRevision=source.revisionId,selectedCompany=companyId;
  const capturedHeaders=reviewedHeaders?.map(header=>({...header}));
  pending.current=true;setAiPending(true);
  try{
   let request=saved.current;
   if(!reopen){
    const packet=await preparePersonnelHeaderAssistancePacket({companyId:selectedCompany,operationNonce:crypto.randomUUID(),headers:capturedHeaders!,sendHeadingsOnly:true,...evaluationBinding?{evaluationBinding:{...evaluationBinding}}:{}});
    request={packet,localRevision,companyId:selectedCompany,evaluationKey:JSON.stringify(packet.evaluationBinding),indexes:new Map(eligible.filter(row=>aiColumns.includes(row.index)).map(row=>[originalIndex(row.index),row.index]))};
    if(!current(request))return;
    saved.current=request;
   }
   if(!request||!current(request)){if(alive.current)setAiStatus('stale');return;}
   let result;
   if(reopen){
    // This operation can ONLY read an existing completed proposal. It cannot prepare, claim,
    // admit a model, or resurrect a row removed by retention.
    if(!request.binding){setAiStatus('uncertain');return;}
    result=await reopenPersonnelImportHeadersAction({...request.binding,request:request.packet});
   }else{
    const prepared=await preparePersonnelImportHeadersAction(request.packet);
    if(!current(request)){if(alive.current)setAiStatus('stale');return;}
    if(prepared.kind!=='prepared'){setAiStatus('unavailable');return;}
    const binding=z.object({kind:z.literal('prepared'),attemptId:z.string().uuid(),attemptVersion:z.literal(1),sourceRevision:z.string(),registryDigest:z.string(),evaluationBinding:EmployeeImportEvaluationBindingSchema.optional()}).strict().parse(prepared);
    if(binding.sourceRevision!==request.packet.sourceRevision||binding.registryDigest!==request.packet.registryDigest||JSON.stringify(binding.evaluationBinding)!==JSON.stringify(request.packet.evaluationBinding))throw Error();
    request={...request,binding:{attemptId:binding.attemptId,attemptVersion:binding.attemptVersion}};
    saved.current=request;
    // Same explicit human consent covers this first execute. No later retry can enter here.
    result=await assistPersonnelImportHeadersAction({...request.binding,request:request.packet});
   }
   if(!current(request)){if(alive.current)setAiStatus('stale');return;}
   if(result.kind!=='proposal'){setProposal(null);setAdopted(null);setAiStatus('unavailable');return;}
   const envelope=z.object({kind:z.literal('proposal'),attemptId:z.string().uuid(),attemptVersion:z.literal(1),proposal:z.unknown(),evaluationBinding:EmployeeImportEvaluationBindingSchema.optional()}).strict().parse(result);
   const value=capturePersonnelImportHeaderProposal(envelope.proposal,request.packet.headers);
   if(JSON.stringify(envelope.evaluationBinding)!==JSON.stringify(request.packet.evaluationBinding)||envelope.attemptId!==request.binding?.attemptId||envelope.attemptVersion!==request.binding?.attemptVersion||value.sourceRevision!==request.packet.sourceRevision||value.registryDigest!==request.packet.registryDigest
    ||value.mappings.some(mapping=>(mapping.status==='mapped'?[mapping.field]:mapping.status==='ambiguous'?mapping.fields:[]).some(field=>!choices.some(choice=>choice.key===field))))throw Error();
   setProposal({value,saved:request});setAiStatus('ready');
  }catch{if(alive.current)setAiStatus(saved.current?'uncertain':'unavailable');}
  finally{pending.current=false;if(alive.current)setAiPending(false);}
 };
 const useSuggestion=(columnIndex:number,field:string)=>{
  if(disabled||pending.current||!proposal||!current(proposal.saved)){setAiStatus('stale');return;}
  const index=proposal.saved.indexes.get(columnIndex);if(index===undefined||!choices.some(choice=>choice.key===field))return;
  setSelected(old=>old.map((value,i)=>i===index?field:value));
  const binding=proposal.saved.binding!;setAdopted(old=>({attemptId:binding.attemptId,attemptVersion:binding.attemptVersion,fields:{...(old?.attemptId===binding.attemptId?old.fields:{}),[index]:field}}));
 };
 const duplicates=new Set(selected.filter((key,index)=>key&&selected.indexOf(key)!==index));
 const ready=selected.length===source.matrix[0].length&&selected.every(key=>choices.some(choice=>choice.key===key))&&duplicates.size===0;
 return <section aria-labelledby={id} className="space-y-4 rounded-lg border border-border bg-background p-4">
  <div><h3 id={id} className="text-sm font-semibold">{messages.title}</h3><p className="mt-1 text-sm text-muted-foreground">{messages.localOnly}</p>
   <p className="mt-2 text-xs text-muted-foreground">{messages.sheet}: {source.sheetName??messages.unknownSheet}</p></div>
  <div className="max-h-[30rem] overflow-auto rounded-md border border-border"><table className="w-full text-left text-xs"><thead className="sticky top-0 bg-muted"><tr>{[messages.column,messages.sourceHeading,messages.sampleValues,messages.destination].map(label=><th key={label} scope="col" className="p-3 font-medium">{label}</th>)}</tr></thead><tbody>
   {suggestions.map((row,index)=>{const issue=duplicates.has(selected[index])?messages.duplicate:!selected[index]?row.matches.length>1?messages.ambiguous:messages.unresolved:null;
    return <tr key={index} className="border-t border-border align-top"><td className="p-3">{source.provenance?.rows[0]?.cells[index]?.column??index+1}</td><th scope="row" className="max-w-64 break-words p-3 font-medium">{row.raw}</th>
     <td className="max-w-64 p-3"><ul className="space-y-1">{source.matrix.slice(1,4).map((values,r)=><li key={r} className="break-words whitespace-pre-wrap">{source.provenance?.rows.find(row=>row.row===source.rowNumbers[r+1])?.cells[index]?.display??values[index]??'—'}</li>)}</ul></td>
     <td className="min-w-52 p-3"><label htmlFor={`${id}-${index}`} className="sr-only">{messages.destination}: {row.raw}</label><select id={`${id}-${index}`} className={inputCls} value={selected[index]??''} disabled={disabled} aria-invalid={!!issue} aria-describedby={issue?`${id}-issue-${index}`:undefined} onChange={e=>{setSelected(old=>old.map((value,i)=>i===index?e.target.value:value));setAdopted(old=>{if(!old)return null;const fields={...old.fields};delete fields[index];return{...old,fields};});}}>
      <option value="">{messages.chooseField}</option>{choices.map(choice=><option key={choice.key} value={choice.key}>{choice.label}</option>)}</select>{issue&&<p id={`${id}-issue-${index}`} className="mt-1 text-destructive">{issue}</p>}</td></tr>;
   })}
  </tbody></table></div>
  {allowAi&&<details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm font-medium">{messages.aiTitle}</summary>
   <div className="mt-3 space-y-3"><p className="text-sm text-muted-foreground">{messages.aiDescription}</p>
    {eligible.length===0?<p className="text-sm">{messages.aiNoHeadings}</p>:<>
     <fieldset disabled={disabled||aiPending||!!saved.current} className="space-y-2"><legend className="mb-2 text-sm font-medium">{messages.aiChoose}</legend>{eligible.map(row=><label key={row.index} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={aiColumns.includes(row.index)} onChange={e=>{setConsented(false);setAiColumns(old=>e.target.checked?[...old,row.index].sort((a,b)=>a-b):old.filter(index=>index!==row.index));}}/><span>{originalIndex(row.index)+1}: {row.raw}</span></label>)}</fieldset>
     <p className="text-xs text-muted-foreground">{messages.aiSelected}: {aiColumns.length}/32</p>
     {aiColumns.length>0&&(!reviewedHeaders||aiColumns.length>32)&&<p role="alert" className="text-sm text-destructive">{messages.aiLimit}</p>}
     {reviewedHeaders&&<div className="rounded-md bg-muted p-3"><p className="mb-2 text-xs font-medium">{messages.aiSelected}</p><pre className="overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(saved.current?.packet.headers??reviewedHeaders,null,2)}</pre></div>}
     <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consented} disabled={disabled||aiPending||!!saved.current||!reviewedHeaders||aiColumns.length>32} onChange={e=>setConsented(e.target.checked)}/><span>{messages.aiConsent}</span></label>
     <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={disabled||aiPending||!consented||!reviewedHeaders||aiColumns.length>32||!!saved.current} onClick={()=>void requestAssistance(false)}>{aiPending?messages.aiWorking:messages.aiSend}</Button>
      {saved.current&&<>{saved.current.binding&&<Button type="button" variant="outline" disabled={disabled||aiPending} onClick={()=>void requestAssistance(true)}>{messages.aiReopen}</Button>}<Button type="button" variant="outline" disabled={disabled||aiPending} onClick={()=>{saved.current=null;setProposal(null);setAdopted(null);setAiStatus('idle');setConsented(false);}}>{messages.aiNewRequest}</Button></>}
     </div>
    </>}
    {aiStatus!=='idle'&&<p role="status" className="text-sm text-muted-foreground">{messages[aiStatus==='ready'?'aiReady':aiStatus==='stale'?'aiStale':aiStatus==='uncertain'?(saved.current?.binding?'aiUncertain':'aiPrepareUnknown'):'aiUnavailable']}</p>}
    {proposal&&current(proposal.saved)&&<ul className="space-y-2">{proposal.value.mappings.map(mapping=><li key={mapping.columnIndex} className="space-y-1 text-sm"><p>{proposal.saved.packet.headers.find(header=>header.columnIndex===mapping.columnIndex)?.heading}</p>
     {mapping.status==='unresolved'?<p className="text-muted-foreground">{messages.unresolved}</p>:(mapping.status==='mapped'?[mapping.field]:mapping.fields).map(field=><Button type="button" key={field} variant="outline" disabled={disabled||aiPending} onClick={()=>useSuggestion(mapping.columnIndex,field)}>{messages.aiUseSuggestion}: {choices.find(choice=>choice.key===field)?.label}</Button>)}
    </li>)}</ul>}
   </div>
  </details>}
  <div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled||!ready} onClick={()=>{
   const binding=proposal?.saved.binding,used=adopted&&proposal&&current(proposal.saved)&&binding?.attemptId===adopted.attemptId&&binding?.attemptVersion===adopted.attemptVersion?Object.entries(adopted.fields).filter(([index,field])=>selected[Number(index)]===field).length:0;
   onApply([...selected],source.revisionId,used&&binding?{attemptId:binding.attemptId,attemptVersion:binding.attemptVersion,adoptedMappings:used}:undefined);
  }}>{messages.applyMapping}</Button><Button type="button" variant="outline" disabled={disabled} onClick={onCancel}>{messages.cancel}</Button></div>
 </section>;
}
