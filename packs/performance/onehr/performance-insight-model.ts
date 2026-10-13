import { evidenceFigureInText,evidenceNumbers } from './evidence-figure-model';
import type { EvidenceText } from './evidence-extraction';
import type { PMBand } from './model';

/** The source reviewer insight is derived advice. It never changes an assessment or its rating. */
export type InsightFile={id:string;name:string;note:string};
export type InsightModeration={by:string;from:number;to:number;from_res:string;to_res:string;why:string};
export type InsightRow={id:string;kpi:string;band:PMBand|null;rating:number|null;mod_band:PMBand|null;value:number;result:string;target:string|null;target_raw:number|null;unit:string;direction:'higher is better'|'lower is better';weight:number;mech:'A'|'B';scale:string;note:string;file_list:InsightFile[];moderation:InsightModeration[];mod_value:number|null;mod_result:string|null;locked:boolean;approvers:string[]};
export type InsightFacts={rows:InsightRow[];remark:string;overall?:{value:number|null;label:PMBand|null}|null;self_overall?:{value:number|null;label:PMBand|null}|null;reviewer_kind?:'manager'|'calibrator';mgr_remarks?:{author:string;remark:string;role?:string}[];trail?:{tier:string;label:string;by:string;from:PMBand|null;band:PMBand|null;note:string}[];hr?:{kpi:string;band:PMBand|null}[]};
export type InsightEvidence='none'|'unread'|'found'|'not_found'|'supports'|'not_shown'|'partly'|'contradicts';
export type InsightJustification='no'|'partly'|'yes';
export type InsightVerdict='not_justified'|'partly_justified'|'well_justified';
export type InsightKpi={kpi:string;band:PMBand|null;mod_band:PMBand|null;group:'well'|'short'|'other';result:string;target:string|null;unit:string;direction:'higher'|'lower';their_note:string;mod_result:string|null;mod_dir:'up'|'down'|null;mod_group:'well'|'short'|'other'|null;mod_band_now:PMBand|null;moderation:{by:string;from:string;to:string;why:string;why_short:string}[];read:string;evidence:InsightEvidence;evidence_note:string;files:{id:string;name:string}[];justified:InsightJustification;justified_why:string};
export type PerformanceInsight={paragraph:string;read:string;kpis:InsightKpi[];verdict:InsightVerdict|null;verdict_why:string;discuss:string[]};
export type InsightAssessment={kpis?:Record<string,{justified?:InsightJustification;why?:string}>;verdict?:InsightVerdict;verdict_why?:string};
const justRank={no:0,partly:1,yes:2},verdictRank={not_justified:0,partly_justified:1,well_justified:2};
const labels:Record<PMBand,string>={UA:'Unacceptable',BE:'Below Expectation',ME:'Meet Expectation',AE:'Above Expectation',OU:'Outstanding'};
const statusWhy:Record<string,string>={no_text:'it has no readable text -- it may be a scan',unreadable:"the file couldn't be opened",unsupported:"that file type can't be read",too_big:'it is too large or too complex to read',retry:"it hasn't been read yet",unread:"it hasn't been read yet"};
const bottom:Record<InsightVerdict,string>={well_justified:'The evidence bears out their results.',partly_justified:'The evidence only partly bears out their results.',not_justified:"The evidence doesn't bear out their results as they stand."};
export function insightPosition(r:InsightRow){
 const v=r.value,t=r.target_raw;if(t==null||!Number.isFinite(v)||!Number.isFinite(t))return null;
 if(Math.abs(v-t)<=Math.abs(t)*.0005)return 'on';return (r.direction==='higher is better'?v>t:v<t)?'above':'below';
}
export function insightGroup(r:InsightRow):InsightKpi['group']{const position=insightPosition(r);return position?position==='below'?'short':'well':r.band&&['ME','AE','OU'].includes(r.band)?'well':r.band&&['UA','BE'].includes(r.band)?'short':'other';}
export function insightModerationDirection(r:InsightRow):InsightKpi['mod_dir']{
 if(r.mod_value==null||Math.abs(r.value-r.mod_value)<=Math.max(Math.abs(r.value)*.0005,1e-9))return null;
 return (r.direction==='higher is better'?r.mod_value>r.value:r.mod_value<r.value)?'up':'down';
}
const moderated=(r:InsightRow):InsightRow=>({...r,value:r.mod_value??r.value,band:r.mod_band??r.band});
const fileText=(r:InsightRow,texts:Map<string,EvidenceText>)=>r.file_list.map(f=>texts.get(f.id)).filter(t=>t?.status==='ok').map(t=>t!.text).join('\n');
export function insightEvidence(r:InsightRow,texts:Map<string,EvidenceText>,modelEvidence?:InsightEvidence,modelNote='',plain=false):[InsightEvidence,string]{
 if(!r.file_list.length)return ['none',''];
 const tx=r.file_list.map(f=>texts.get(f.id));if(!tx.some(t=>t?.status==='ok'))return ['unread',`Couldn't read the file (${statusWhy[tx[0]?.status??'unread']??'not read'}).`];
 const contents=fileText(r,texts),found=evidenceFigureInText(r.value,contents),modFound=r.mod_value!=null&&evidenceFigureInText(r.mod_value,contents),miss=`The keyed figure (${r.result}) doesn't appear in the file.`;
 const hit:[InsightEvidence,string]|null=found?['found',`The keyed figure (${r.result}) appears in the file.`]:modFound?['found',`The moderated figure (${r.mod_result}) appears in the file.`]:null;
 if(plain||!modelEvidence||!['supports','partly','contradicts','not_shown'].includes(modelEvidence))return hit??['not_found',miss];
 if(modelEvidence==='supports'&&!found&&!modFound)return ['not_shown',miss];
 if(modelEvidence==='contradicts'&&r.mod_value!=null&&found&&!modFound)return ['contradicts',modelNote||`The file shows their figure (${r.result}), not the moderated ${r.mod_result}.`];
 if(modelEvidence==='contradicts'||modelEvidence==='partly'){
  const known=[r.value,r.target_raw,r.mod_value,...r.moderation.flatMap(m=>[m.from,m.to])].filter((n):n is number=>n!=null);
  const cited=evidenceNumbers(modelNote).map(n=>n.value).filter(n=>!known.some(v=>Math.abs(n-v)<=Math.max(Math.abs(v)*.005,1e-9)));
  if(cited.some(n=>!evidenceFigureInText(n,contents))||modelEvidence==='contradicts'&&(found||modFound)&&!cited.length)return hit??['not_found',miss];
 }
 return [modelEvidence,modelNote];
}
function short(text:string,n=12){const words=text.trim().split(/\s+/).filter(Boolean);return words.slice(0,n).join(' ').replace(/[,;:]+$/,'')+(words.length>n?'…':'');}
function explained(r:InsightRow,remark:string){const name=r.kpi.trim().toLowerCase();return !!r.note.trim()||name.length>=4&&remark.toLowerCase().includes(name);}
function justifyOwn(k:Pick<InsightKpi,'evidence'|'group'|'band'>,r:InsightRow,remark:string):[InsightJustification,string]{
 const ev=k.evidence,expl=explained(r,remark),strong=k.group==='well'&&(k.band==='AE'||k.band==='OU');
 if(ev==='supports'||ev==='found')return ['yes','the file shows their figure'];
 if(ev==='contradicts')return ['no',"the file doesn't match their result"];
 if(['partly','not_found','not_shown','unread'].includes(ev))return ['partly',(ev==='unread'?"the file couldn't be read":"the file doesn't show their figure")+(expl?', though they explain it':'')];
 if(strong)return expl?['partly','explained in their words, but no file backs it']:['no','above target with no file and no note behind it'];
 if(k.group==='well')return expl?['yes','on target, and they explain it']:['partly','on target; no note on how'];
 if(k.group==='short')return expl?['yes','below target, and they explain what got in the way']:['partly','below target with no context given'];
 return ['partly','no file or explanation'];
}
export function insightJustification(k:Pick<InsightKpi,'evidence'|'group'|'band'>,r:InsightRow,remark:string,texts:Map<string,EvidenceText>):[InsightJustification,string]{
 const direction=r.moderation.length?insightModerationDirection(r):null;if(!direction)return justifyOwn(k,r,remark);
 const m=r.moderation[r.moderation.length-1],why=[...r.moderation].reverse().find(x=>x.why)?.why??'',contents=fileText(r,texts),how=`their manager moderated it ${direction} to ${m.to_res}`;
 if(contents&&r.mod_value!=null&&evidenceFigureInText(r.mod_value,contents))return ['yes',how+', and the file shows that figure'];
 let row=moderated(r);if(direction==='up'&&why)row={...row,note:row.note||why};
 const km={band:row.band,group:insightGroup(row),evidence:['supports','found','partly','not_found','not_shown'].includes(k.evidence)?'none' as const:k.evidence};
 let [code]=justifyOwn(km,row,remark);
 if(direction==='down'){
  if(k.evidence==='supports'||k.evidence==='found'||k.evidence==='contradicts'&&contents&&evidenceFigureInText(r.value,contents))return ['partly','the file shows their figure, but '+how+' — worth asking why'];
  if(justRank[code]>justRank.partly)code='partly';return [code,how];
 }
 return [code,how+(code!=='yes'&&k.evidence==='none'?'; no file backs it':'')];
}
function entry(r:InsightRow,texts:Map<string,EvidenceText>):InsightKpi{
 const [ev,note]=insightEvidence(r,texts,undefined,'',true);
 const read=r.note?'Their note: “'+(r.note.length<=140?r.note:r.note.slice(0,140).replace(/\s+\S*$/,'')+'…')+'”':'';
 return {kpi:r.kpi,band:r.band,mod_band:r.mod_band&&r.mod_band!==r.band?r.mod_band:null,group:insightGroup(r),result:r.result,target:r.target,unit:r.unit,direction:r.direction==='lower is better'?'lower':'higher',their_note:r.note,mod_result:r.mod_result,mod_dir:insightModerationDirection(r),mod_group:r.moderation.length?insightGroup(moderated(r)):null,mod_band_now:r.moderation.length?r.mod_band??r.band:null,moderation:r.moderation.map(m=>({by:m.by,from:m.from_res,to:m.to_res,why:m.why,why_short:short(m.why,14)})),read,evidence:ev,evidence_note:note,files:r.file_list.map(f=>({id:f.id,name:f.name})),justified:'partly',justified_why:''};
}
function verdictServer(kpis:InsightKpi[],remark:string):InsightVerdict|null{if(!kpis.length)return null;if(kpis.some(k=>k.justified==='no'))return 'not_justified';return kpis.every(k=>k.justified==='yes')&&remark.trim()?'well_justified':'partly_justified';}
function verdictWhy(kpis:InsightKpi[],remark:string){
 const clause=(text:string)=>{const w=text.trim().replace(/[ .;]+$/,'');return w.slice(0,2)!==w.slice(0,2).toUpperCase()||w.length<2?w.charAt(0).toLowerCase()+w.slice(1):w;};
 const bits=[...kpis].sort((a,b)=>justRank[a.justified]-justRank[b.justified]).slice(0,3).filter(k=>k.justified_why).map(k=>`${k.kpi}: ${clause(k.justified_why)}`),n=remark.trim().split(/\s+/).filter(Boolean).length;
 const tail=n>=60?'Their remark explains the period.':n?'Their remark is brief.':'They wrote no overall remark.';return bits.length?bits.join('; ')+'. '+tail:tail;
}
function posWords(k:InsightKpi){const group=k.mod_dir?k.mod_group:k.group,band=k.mod_dir?k.mod_band_now:k.band;return group==='short'?'below target':band==='AE'||band==='OU'?'above target':'on target';}
function steps(kpis:InsightKpi[],verdict:InsightVerdict|null,calibrator:boolean){
 const out:string[]=[];
 for(const k of [...kpis].sort((a,b)=>justRank[a.justified]-justRank[b.justified])){
  const unreasoned=calibrator&&k.mod_dir&&!k.moderation.some(m=>m.why),theirs=k.justified_why.includes('the file shows their figure, but');
  if(k.evidence==='contradicts'&&!theirs)out.push(calibrator?`Check the file on ${k.kpi} — it doesn't match their result.`:`The file on ${k.kpi} doesn't match their result — check it before you decide.`);
  else if(unreasoned)out.push(`Ask their manager why ${k.kpi} was moderated ${k.mod_dir}.`);
  else if(calibrator&&k.mod_dir==='down'&&theirs)out.push(`Ask their manager why ${k.kpi} was moderated down — the file shows their figure.`);
  else if(k.justified==='no')out.push(calibrator?`Ask for evidence behind ${k.kpi}'s ${posWords(k)} result.`:`No supporting file for ${k.kpi}, a result ${posWords(k)} — ask for evidence before you decide.`);
  else if(k.evidence==='not_found'||k.evidence==='not_shown')out.push(calibrator?`Ask for a file on ${k.kpi} that shows their figure.`:`The file on ${k.kpi} doesn't show their figure — ask for one that does.`);
  else if(k.justified==='partly'&&k.group==='short')out.push(calibrator?`Ask what held ${k.kpi} back.`:`Ask what held ${k.kpi} back — no context was given.`);
 }
 if(verdict==='well_justified'&&!out.length)out.push(calibrator?'Nothing to query — every result is backed or explained.':'Nothing to query — you can take the results as entered.');return out;
}
export function mergeInsightDiscuss(server:string[],model:string[],names:string[],limit=3){
 const seen=new Set<string>(),covered=new Set<string>(),out:string[]=[];
 for(const text of [...server,...model]){const key=text.toLowerCase().replace(/\W+/g,' ').trim(),about=names.filter(n=>n&&text.toLowerCase().includes(n.toLowerCase())).map(n=>n.toLowerCase());if(!key||seen.has(key)||about.length&&about.every(n=>covered.has(n)))continue;seen.add(key);about.forEach(n=>covered.add(n));out.push(text);}return out.slice(0,limit);
}
export function applyInsightAssessment(kpis:InsightKpi[],facts:InsightFacts,texts:Map<string,EvidenceText>,model:InsightAssessment={}){
 kpis.forEach((k,i)=>{
  const r=facts.rows[i];let [code,why]=insightJustification(k,r,facts.remark,texts);const m=model.kpis?.[r.id];
  const upgradable=code==='partly'&&k.evidence==='none'&&!k.mod_dir&&!(k.group==='well'&&(k.band==='AE'||k.band==='OU'));
  if(m?.justified&&justRank[m.justified]<justRank[code]){code=m.justified;why=m.why||why;}
  else if(m?.justified==='yes'&&upgradable&&m.why){code='yes';why=m.why;}
  else if(m?.justified===code&&m.why)why=m.why;
  k.justified=code;k.justified_why=why;
 });
 const server=verdictServer(kpis,facts.remark);let verdict=server,why=verdictWhy(kpis,facts.remark);
 if(model.verdict&&server&&verdictRank[model.verdict]<=verdictRank[server]){verdict=model.verdict;why=model.verdict_why||why;}
 return {verdict,verdict_why:why,steps:steps(kpis,verdict,facts.reviewer_kind==='calibrator')};
}
function countRead(on:number,n:number){if(!n)return 'No results yet.';if(n===1)return `Their one KPI ${on?'met or beat target':'came in below target'}.`;if(on===n)return (n===2?'Both KPIs met or beat target':`All ${n} KPIs met or beat target`)+'.';if(!on)return (n===2?'Both KPIs came in below target':`None of the ${n} KPIs met target`)+'.';return `${on} of ${n} KPIs met or beat target.`;}
function backingRead(read:string,kpis:InsightKpi[],verdict:InsightVerdict|null,remark:string,nShort:number){
 if(!kpis.length||read==='No results yet.')return read;
 const files=kpis.reduce((n,k)=>n+k.files.length,0),notes=kpis.filter(k=>k.their_note.trim()).length;
 const tail=verdict==='well_justified'?nShort&&remark?', and their remark explains what got in the way':', and the evidence backs it':!files&&!notes&&!remark.trim()?', but nothing backs it: no files, no notes and no overall remark':verdict==='not_justified'?', but not every result is backed':', but not all of it is backed or explained';
 return read.replace(/\.$/,'')+tail+'.';
}
function casePlain(facts:InsightFacts,kpis:InsightKpi[],verdict:InsightVerdict|null,read:string){
 const q=(t:string,n:number)=>'“'+short(t,n).replace(/[.!? ]+$/,'')+'”',out=[verdict?bottom[verdict]:'',read].filter(Boolean);
 const low=(text:string,otherwise:string)=>text?text.charAt(0).toLowerCase()+text.slice(1):otherwise;
 const pro=kpis.filter(k=>k.justified==='yes').map(k=>`${k.kpi} (${low(k.justified_why.trim().replace(/\.$/,''),'backed')})`),con=kpis.filter(k=>k.justified==='partly'||k.justified==='no').map(k=>`${k.kpi} (${low(k.justified_why.trim().replace(/\.$/,''),'not backed')})`);
 if(pro.length)out.push('What backs it: '+pro.join('; ')+'.');if(con.length)out.push("What doesn't: "+con.join('; ')+'.');
 if(facts.remark)out.push('They say: '+q(facts.remark,28)+'.');else if(!read.includes('overall remark'))out.push('They wrote no overall remark.');
 const mods=kpis.flatMap(k=>k.moderation.map(m=>({k,m})));
 for(const {k,m} of mods)out.push(`Their line manager (${m.by}) moderated ${k.kpi} from ${m.from} to ${m.to}`+(m.why?', noting '+q(m.why,20):', with no reason given')+'.');
 for(const m of facts.mgr_remarks??[])out.push(`Their line manager's remark (${m.author}): ${q(m.remark,28)}.`);
 if(!mods.length&&!facts.mgr_remarks?.length)out.push('Their line manager has written no remark.');
 for(const t of facts.trail??[]){const note=/^\s*(Moved to fit the calibration curve|Set on their own results)/.test(t.note)?'':t.note.trim();out.push(`The ${t.label} ${t.from===t.band?'kept them at':'placed them at'} ${t.band?labels[t.band]:'not rated'}`+(note?', noting '+q(note,24):', with no note')+'.');}
 return out.join(' ');
}
/** Deterministic fallback: exact source evidence floors, moderation attribution and next steps. */
export function plainPerformanceInsight(facts:InsightFacts,texts:Map<string,EvidenceText>):PerformanceInsight{
 const kpis=facts.rows.map(r=>entry(r,texts)),rated=kpis.filter(k=>k.group!=='other'),on=rated.filter(k=>k.group==='well').length;let read=countRead(on,rated.length);
 const nm=(code:PMBand|null)=>code?labels[code]:'not rated',bits=[read],well=kpis.filter(k=>k.group==='well'),shortfall=kpis.filter(k=>k.group==='short');
 if(well.length)bits.push('On or above target: '+well.map(k=>`${k.kpi} (${nm(k.band)}, keyed ${k.result})`).join(', ')+'.');
 if(shortfall.length)bits.push('Below target: '+shortfall.map(k=>`${k.kpi} (${nm(k.band)}, keyed ${k.result})`).join(', ')+'.');
 const evBits=kpis.flatMap(k=>k.evidence==='found'?[`the file on ${k.kpi} has a matching figure`]:k.evidence==='not_found'?[`the file on ${k.kpi} doesn't show the keyed figure`]:k.evidence==='unread'?[`the file on ${k.kpi} couldn't be read`]:[]);
 if(evBits.length){const t=evBits.join('; ');bits.push(t.charAt(0).toUpperCase()+t.slice(1)+'.');}
 const noFile=kpis.filter(k=>k.evidence==='none').map(k=>k.kpi);if(noFile.length)bits.push('No supporting file on '+noFile.join(' or ')+'.');
 for(const k of kpis)for(const m of k.moderation)bits.push(`Their line manager (${m.by}) moderated ${k.kpi} from ${m.from} to ${m.to}`+(m.why?': “'+short(m.why,20)+'”':', with no reason given')+'.');
 for(const m of facts.mgr_remarks??[])bits.push(`Their line manager's remark (${m.author}): “${short(m.remark,28)}”`);
 if(facts.reviewer_kind==='calibrator'&&!facts.mgr_remarks?.length&&!kpis.some(k=>k.moderation.length))bits.push('Their line manager has not written a remark.');
 bits.push(facts.remark?'Their remark: “'+(facts.remark.length<=160?facts.remark:facts.remark.slice(0,160).replace(/\s+\S*$/,'')+'…')+'”':'They wrote no overall remark.');
 const result=applyInsightAssessment(kpis,facts,texts);read=backingRead(read,kpis,result.verdict,facts.remark,rated.length-on);bits[0]=read;
 return {paragraph:facts.reviewer_kind==='calibrator'?casePlain(facts,kpis,result.verdict,read):bits.join(' '),read,kpis,verdict:result.verdict,verdict_why:result.verdict_why,discuss:mergeInsightDiscuss(result.steps,[],kpis.map(k=>k.kpi))};
}
