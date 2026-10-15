import { z } from 'zod';
import { todayInKualaLumpur } from '../../../lib/hr-date';
import { checkInAnswers } from './model';
import { evidenceFieldsSchema } from './evidence-model';

const span=z.object({start:z.number().int().min(0),end:z.number().int().min(1)}).strict();
export const evidenceCommandsSchema=z.object({commands:z.array(z.discriminatedUnion('action',[
 z.object({action:z.literal('log_evidence'),body:span,kpi:z.object({id:z.uuid(),target:span}).strict().optional(),occurredOn:span.optional()}).strict(),
 z.object({action:z.literal('checkin'),id:z.uuid(),target:span,answer:span,note:span.optional()}).strict(),
])).max(20)}).strict();
export type EvidenceCommandFacts={text:string;canLog:boolean;canCheckIn:boolean;kpis:{id:string;label:string;approved:boolean;note:string}[]};
const normal=(s:string)=>s.trim().normalize('NFKC').toLocaleLowerCase('en');
/** Source log_evidence/checkin tools retain actor words; no rating, file truth or approval is inferred. */
export function adjudicateEvidenceCommands(raw:string,facts:EvidenceCommandFacts){
 try{
  const proposal=evidenceCommandsSchema.parse(JSON.parse(raw)),used=new Set<string>();
  const extract=(s:z.infer<typeof span>)=>{if(s.end>facts.text.length||s.start>=s.end)throw Error('Invalid message span.');return facts.text.slice(s.start,s.end).trim();};
  const target=(id:string,s:z.infer<typeof span>)=>{const label=extract(s),k=facts.kpis.find(k=>k.id===id);if(!k||normal(k.label)!==normal(label)||facts.kpis.filter(k=>normal(k.label)===normal(label)).length!==1)throw Error('Name one assigned employee-owned KPI exactly.');return k;};
  const commands=proposal.commands.map(c=>{
   if(c.action==='log_evidence'){
    if(!facts.canLog)throw Error('Evidence is unavailable.');
    const body=extract(c.body);
    if(body.length<12||/^(yes|no|okay|ok|sure|thanks|thank you|i agree|i can share)[.! ]*$/i.test(body))throw Error('Describe the actual event or action.');
    if(c.kpi)target(c.kpi.id,c.kpi.target);
    const fields=evidenceFieldsSchema.parse({kind:'recognition',body,occurredOn:c.occurredOn?extract(c.occurredOn):todayInKualaLumpur()});
    const key=`evidence:${c.body.start}:${c.body.end}`;if(used.has(key))throw Error('Duplicate evidence.');used.add(key);
    return {action:'log_evidence' as const,fields,links:c.kpi?[{kind:'kpi' as const,id:c.kpi.id}]:[]};
   }
   const k=target(c.id,c.target);
   if(!facts.canCheckIn||!k.approved)throw Error('This KPI is not ready for a check-in.');
   if(used.has(c.id))throw Error('Conflicting check-ins.');used.add(c.id);
   const value=normal(extract(c.answer)).replaceAll(' ','_');
   const answer=z.enum(checkInAnswers).parse(value),note=c.note?extract(c.note):k.note;
   z.string().max(4000).parse(note);
   return {action:'checkin' as const,id:c.id,answer,note};
  });
  return {ok:true as const,proposal,commands};
 }catch(error){return {ok:false as const,reason:error instanceof Error?error.message:'Invalid evidence command.'};}
}
