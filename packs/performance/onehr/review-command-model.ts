import { z } from 'zod';
import { assessmentDraftSchema, assertOverallRemark, type AssessmentDraft } from './journey-model';
const span=z.object({start:z.number().int().min(0),end:z.number().int().min(1)}).strict();
const commandSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('kpi_result'),id:z.uuid(),target:span,actual:span,note:span.optional()}).strict(),
 z.object({action:z.literal('kpi_note'),id:z.uuid(),target:span,note:span}).strict(),
 z.object({action:z.literal('competency_answer'),id:z.string().min(1).max(100),target:span,answer:span,remark:span.optional()}).strict(),
 z.object({action:z.literal('feedback_answer'),id:z.string().min(1).max(100),target:span,answer:span}).strict(),
 z.object({action:z.literal('feedback_comment'),id:z.string().min(1).max(300),target:span,text:span}).strict(),
 z.object({action:z.literal('overall_remark'),text:span}).strict(),
]);
export const reviewCommandsSchema=z.object({commands:z.array(commandSchema).max(50)}).strict();
export type ReviewCommandFacts={text:string;draft:AssessmentDraft;targets:{id:string;label:string;competency?:{title:string;category:string;future:boolean}}[]};
const competencyAnswers:Record<string,'yes'|'no'>={yes:'yes',demonstrate:'yes',demonstrated:'yes',no:'no',developing:'no',develop:'no'};
const competencyStubs=new Set(['yes','yeah','yep','yup','sure','ok','okay','of course','definitely','absolutely','i can','i can share','yes i can','yes i can share','yes sure','yes please','yes i will','i will','i will share','yes of course','sounds good','will do','no problem','add example','add an example','add a note','add note','add growth example','add a growth example','add strength example','prepare final submission','show competency list','show the list','i m done','no example','no thanks','nothing to add','type example','draft with ai','draft it','draft it for me','help me draft']);
const competencyStub=(text:string)=>[...text.trim()].length<6||competencyStubs.has(text.toLowerCase().replace(/[^a-z ]/g,' ').trim().replace(/\s+/g,' '));
const placeholder=(text:string)=>/\[[^\]]{0,200}\]|<[a-z][^>]{0,60}>|\b(please replace|replace this|replace the text|fill in|insert your|your note here|add a (brief )?note here|placeholder|to be (filled|completed)|tbd)\b/i.test(text);
const normal=(text:string)=>text.trim().normalize('NFKC').toLocaleLowerCase('en');
/** Every new value is extracted from the actor's message. A model cannot supply facts or a rating. */
export function adjudicateReviewCommands(raw:string,facts:ReviewCommandFacts):{ok:true;draft:AssessmentDraft;proposal:z.infer<typeof reviewCommandsSchema>;changed:boolean}|{ok:false;reason:string}{
 try{
  const proposal=reviewCommandsSchema.parse(JSON.parse(raw)),draft=assessmentDraftSchema.parse(structuredClone(facts.draft));
  const used=new Set<string>();
  const extract=(s:z.infer<typeof span>)=>{if(s.end>facts.text.length||s.start>=s.end)throw Error('Invalid message span.');return facts.text.slice(s.start,s.end).trim();};
  for(const command of proposal.commands){
   const key=command.action==='overall_remark'?'overall':command.id;
   if(used.has(key))throw Error('Ambiguous repeated update.');used.add(key);
   if(command.action==='overall_remark'){draft.remark=extract(command.text);if(draft.kind==='competency_self'&&(competencyStub(draft.remark)||placeholder(draft.remark)))throw Error('Write the reflection in your own words.');assertOverallRemark(draft.remark);continue;}
   const target=facts.targets.find(t=>t.id===command.id),reference=extract(command.target);
   if(!target||normal(reference)!==normal(target.label)||facts.targets.filter(t=>normal(t.label)===normal(reference)).length!==1)throw Error('The message does not uniquely name this assigned item.');
   if(command.action==='kpi_result'||command.action==='kpi_note'){
    if(draft.kind!=='results'&&draft.kind!=='moderation')throw Error('This part does not accept KPI results.');
    const line=draft.lines.find(l=>l.id===command.id);if(!line)throw Error('KPI outside the editable draft.');
    if(command.action==='kpi_result'){const value=extract(command.actual);
     if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!Number.isFinite(Number(value)))throw Error('Use an actual number from the message, without calculations.');
     line.actual=Number(value);
    }
    if(command.note)line.note=extract(command.note);
   }else if(command.action==='feedback_answer'){
    if(draft.kind!=='feedback')throw Error('This part does not accept colleague feedback.');
    const answer=normal(extract(command.answer));if(!['yes','no','not yet'].includes(answer))throw Error('Use an explicit yes or not yet answer from the message.');draft.answers[command.id]=answer==='yes'?'yes':'no';
   }else if(command.action==='feedback_comment'){
    if(draft.kind!=='feedback'||!command.id.startsWith('principle:'))throw Error('Choose an assigned feedback principle.');
    draft.comments??={};draft.comments[command.id.slice('principle:'.length)]=extract(command.text);
   }else{
    if(draft.kind!=='competency_self'&&draft.kind!=='competency_manager')throw Error('This part does not accept competency answers.');
    const line=draft.answers[command.id];if(!line)throw Error('Competency outside the editable draft.');
    const answer=competencyAnswers[normal(extract(command.answer))];
    if(!answer)throw Error('Use Demonstrate (yes) or Developing (no) from the message.');
    if(draft.kind==='competency_self'&&answer==='yes'&&target.competency?.future){
     const pair=facts.targets.find(t=>t.competency&&!t.competency.future&&t.competency.title===target.competency!.title&&t.competency.category===target.competency!.category);
     if(pair&&draft.answers[pair.id]?.answer==='no')throw Error('The current level is still Developing. Confirm which level you mean before changing the higher level.');
    }
    line.answer=answer;if(command.remark){const remark=extract(command.remark);if(!competencyStub(remark))line.remark=remark;}
   }
  }
  return {ok:true,draft:assessmentDraftSchema.parse(draft),proposal,changed:JSON.stringify(draft)!==JSON.stringify(facts.draft)};
 }catch(error){return {ok:false,reason:error instanceof Error?error.message:'Invalid draft command.'};}
}
