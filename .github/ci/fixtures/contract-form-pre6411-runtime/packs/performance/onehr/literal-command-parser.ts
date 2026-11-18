/** LOCAL explicit human grammar. Names, values and exact UTF-16 offsets never leave this owner.
 * Existing command adjudicators remain responsible for permissions, field bounds and draft semantics. */
import type {SettingCommandFacts} from './setting-command-model';
import type {CareerCommandFacts} from './career-command-model';
import type {ReviewCommandFacts} from './review-command-model';
import type {EvidenceCommandFacts} from './evidence-command-model';
type Span={start:number;end:number};
export type LiteralDraftCommand={action:string;[key:string]:unknown};
const normal=(s:string)=>s.trim().normalize('NFKC').toLocaleLowerCase('en');
const quote=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const span=(text:string,value:string,from=0):Span=>{const start=text.indexOf(value,from);if(start<0||!value.trim())throw Error('Explicit source words unavailable.');return{start,end:start+value.length};};
const unique=<T>(rows:readonly T[],label:string,get:(row:T)=>string):T|null=>{const matches=rows.filter(row=>normal(get(row))===normal(label));return matches.length===1?matches[0]:null;};
const at=(match:RegExpExecArray,group:number):Span=>{const value=match.indices?.[group];if(!value)throw Error('Explicit source span unavailable.');return{start:value[0],end:value[1]};};
const number='[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const verbs={record:'(?:record|catat|记录|ghi nhận|பதிவு செய்|บันทึก)',set:'(?:set|tetapkan|设置|đặt|அமை|ตั้งค่า)',remove:'(?:remove|buang|移除|xóa|நீக்கு|ลบ)',add:'(?:add|tambah|添加|thêm|சேர்|เพิ่ม)'};
export function literalSettingProposal(facts:SettingCommandFacts):{commands:LiteralDraftCommand[]}|null{
 const text=facts.text,change=new RegExp(`^${verbs.set} (.+?) (weight|target|rate[1-5]|threshold|multiple|excellence) (?:to|kepada|为|thành|க்கு|เป็น) (${number})\\s*%?\\.?$`,'diu').exec(text);
 if(change){const item=unique(facts.kpis,change[1],k=>k.title);if(!item)return null;const field=change[2].toLowerCase();return{commands:[{action:field==='weight'?'set_weight':field==='target'?'set_target':'set_number',id:item.id,target:at(change,1),value:at(change,3),...(!['weight','target'].includes(field)?{field}:{})}]};}
 const operation=new RegExp(`^(${verbs.add}|${verbs.remove}) kpi\\s*:\\s*(.+?)\\s*$`,'diu').exec(text);if(!operation)return null;
 const add=new RegExp(`^${verbs.add}$`,'iu').test(operation[1]),item=add?unique(facts.library,operation[2],k=>k.title):unique(facts.kpis,operation[2],k=>k.title);return item?{commands:[{action:add?'add_kpi':'remove_kpi',id:item.id,target:at(operation,2)}]}:null;
}
export function literalCareerProposal(facts:CareerCommandFacts):{commands:LiteralDraftCommand[]}|null{
 const text=facts.text,remove=new RegExp(`^${verbs.remove} (.+?)\\.?$`,'diu').exec(text);
 if(remove){const goal=unique(facts.goals,remove[1],g=>g.area);return goal&&facts.canEditGoals?{commands:[{action:'remove_goal',id:goal.id,target:span(text,remove[1])}]}:null;}
 const aliases:Record<string,string>={aspiration:'aspirationNow',aspirationnow:'aspirationNow',aspirationlong:'aspirationLong',strengths:'strengths',preferences:'preferences',mentor:'mentor',mobilitynote:'mobilityNote',mobility:'mobility','current role':'selfProfileId','target role':'targetProfileId','edit goal':'editGoal',goal:'area','on the job':'onJob','from others':'fromOthers','formal learning':'formalLearning','due on':'dueOn',aspirasi:'aspirationNow',kekuatan:'strengths',matlamat:'area',志向:'aspirationNow',优势:'strengths',目标:'area','nguyện vọng':'aspirationNow','điểm mạnh':'strengths','mục tiêu':'area',விருப்பம்:'aspirationNow',பலங்கள்:'strengths',இலக்கு:'area',ความใฝ่ฝัน:'aspirationNow',จุดแข็ง:'strengths',เป้าหมาย:'area'};
 const marker=new RegExp(`(^|[.;]\\s+|\\n+)(${Object.keys(aliases).map(quote).join('|')})\\s*:\\s*`,'giu'),matches=[...text.matchAll(marker)];if(!matches.length||matches[0].index!==0)return null;
 const commands:LiteralDraftCommand[]=[],used=new Set<string>();let goal:LiteralDraftCommand|null=null;
 for(let i=0;i<matches.length;i++){const match=matches[i],field=aliases[normal(match[2])];if(used.has(field))return null;used.add(field);
  const start=match.index!+match[0].length,next=matches[i+1],end=next?next.index!+(next[1].startsWith('.')?1:0):text.length;let value=text.slice(start,end).trim();if(field==='area'||field==='dueOn')value=value.replace(/[.;]$/,'').trim();if(!value)return null;const valueSpan=span(text,value,start);
  if(['area','dueOn','onJob','fromOthers','formalLearning'].includes(field)){if(!facts.canEditGoals)return null;if(field==='area'){goal={action:'add_goal',area:valueSpan};commands.push(goal);}else{if(!goal)return null;goal[field]=valueSpan;}}
  else if(field==='editGoal'){if(!facts.canEditGoals)return null;const item=unique(facts.goals,value.replace(/[.;]$/,'').trim(),g=>g.area);if(!item)return null;goal={action:'edit_goal',id:item.id,target:span(text,value.replace(/[.;]$/,'').trim(),start)};commands.push(goal);}
  else{if(!facts.canEditCareer)return null;if(field==='selfProfileId'||field==='targetProfileId'){const role=unique(facts.roles,value.replace(/[.;]$/,'').trim(),r=>r.label);if(!role)return null;commands.push({action:'role_choice',field,id:role.id,target:span(text,value.replace(/[.;]$/,'').trim(),start)});}else if(field==='mobility')commands.push({action:'mobility',value:valueSpan});else commands.push({action:'career_field',field,value:valueSpan});}
 }
 return{commands};
}
export function literalReviewProposal(facts:ReviewCommandFacts):{commands:LiteralDraftCommand[]}|null{
 const text=facts.text,remark=/^(?:overall )?remark\s*:\s*([\s\S]+)$/iu.exec(text);if(remark)return{commands:[{action:'overall_remark',text:span(text,remark[1])}]};
 for(const target of facts.targets){
  if(facts.targets.filter(t=>normal(t.label)===normal(target.label)).length!==1)continue;
  const read=new RegExp(`^help me assess ${quote(target.label)}\\.?$`,'iu');if(read.test(text))return{commands:[]};
  const result=new RegExp(`^${verbs.record} (${quote(target.label)}) at (${number})(?:\\.\\s*note\\s*:\\s*([\\s\\S]+))?\\.?$`,'diu').exec(text);
  if(result)return{commands:[{action:'kpi_result',id:target.id,target:at(result,1),actual:at(result,2),...(result[3]?{note:at(result,3)}:{})}]};
  const answer=new RegExp(`^${verbs.record} (${quote(target.label)}) as (yes|no|not yet|demonstrate|demonstrated|developing|develop)(?:\\.\\s*([\\s\\S]+))?\\.?$`,'diu').exec(text);
  if(answer){const command:LiteralDraftCommand={action:facts.draft.kind==='feedback'?'feedback_answer':'competency_answer',id:target.id,target:at(answer,1),answer:at(answer,2)},commands=[command];
   if(answer[3]){const rest=answer[3];if(facts.draft.kind==='feedback'){const candidates=facts.targets.filter(t=>t.id.startsWith('principle:'));const option=candidates.find(t=>new RegExp(`^${quote(t.label)} comment\\s*:\\s*([\\s\\S]+)$`,'iu').test(rest));if(!option||candidates.filter(t=>normal(t.label)===normal(option.label)).length!==1)return null;const note=new RegExp(`^(${quote(option.label)}) comment\\s*:\\s*([\\s\\S]+)$`,'iu').exec(rest)!;commands.push({action:'feedback_comment',id:option.id,target:span(text,note[1],text.indexOf(rest)),text:span(text,note[2],text.indexOf(rest))});}
    else{const note=/^remark\s*:\s*([\s\S]+)$/iu.exec(rest);if(!note)return null;command.remark=span(text,note[1],text.indexOf(rest));}}
   return{commands};
  }
 }
 return null;
}
export function literalEvidenceProposal(facts:EvidenceCommandFacts):{commands:LiteralDraftCommand[]}|null{
 const text=facts.text,log=/^(?:log evidence|rekod bukti|记录证据|ghi bằng chứng|சான்றைப் பதிவு செய்|บันทึกหลักฐาน)\s*:\s*([\s\S]+)$/iu.exec(text);if(log)return facts.canLog?{commands:[{action:'log_evidence',body:span(text,log[1])}]}:null;
 for(const kpi of facts.kpis){const match=new RegExp(`^${verbs.set} (${quote(kpi.label)}) to (on[ _]track|at[ _]risk|off[ _]track|nothing[ _]yet)(?:\\.\\s*note\\s*:\\s*([\\s\\S]+))?\\.?$`,'diu').exec(text);if(match&&facts.canCheckIn&&unique(facts.kpis,match[1],k=>k.label)&&kpi.approved)return{commands:[{action:'checkin',id:kpi.id,target:at(match,1),answer:at(match,2),...(match[3]?{note:at(match,3)}:{})}]};}
 return null;
}
