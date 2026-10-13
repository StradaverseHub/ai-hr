import vocabulary from './insight-vocabulary.json';
import { sourceFigure } from './source-numeric';
import { evidenceFigureInText } from './evidence-figure-model';
import type { EvidenceText } from './evidence-extraction';
import { applyInsightAssessment,insightEvidence,insightGroup,insightPosition,mergeInsightDiscuss,plainPerformanceInsight,type InsightEvidence,type InsightFacts,type InsightJustification,type InsightRow,type InsightVerdict,type PerformanceInsight } from './performance-insight-model';
import { insightBandError,insightClaimError,insightTextGroundingError,insightWordForms } from './insight-grounding';

const plainBands={UA:'far below target',BE:'below target',ME:'on target',AE:'above target',OU:'well above target'};
function where(r:InsightRow){const pos=insightPosition(r),lower=r.direction==='lower is better';if(!pos)return r.band?plainBands[r.band]:'not rated';if(pos==='on')return 'on target';if(lower)return (pos==='above'?'better than target':'worse than target')+' (lower is better)';return pos==='above'?r.band==='OU'?'well above target':'above target':r.band==='UA'?'far below target':'below target';}
const fence=(text:string)=>text.replaceAll('<<<','‹‹‹').replaceAll('>>>','›››');
/** Untrusted passages cannot close their fences. No scaffold numbers become evidence. */
export function performanceCaseText(facts:InsightFacts,texts:Map<string,EvidenceText>){
 const out:string[]=[],unit=facts.rows.every(r=>r.mech==='A')?' out of 5':facts.rows.every(r=>r.mech==='B')?'%':'',own=facts.self_overall,overall=facts.overall;
 if(own?.value!=null){out.push(`OVERALL, by their own results: ${sourceFigure(own.value,2)}${unit} -- ${own.label?plainBands[own.label]:'not rated'} overall.`);if(overall?.value!=null&&overall.label!==own.label)out.push(`OVERALL as moderated so far: ${sourceFigure(overall.value,2)}${unit} -- ${overall.label?plainBands[overall.label]:'not rated'} overall.`);}else out.push('OVERALL: not available yet -- not every KPI has a result.');
 out.push(facts.remark?`THEIR OVERALL REMARK: <<<${fence(facts.remark)}>>>`:'THEIR OVERALL REMARK: none written.');
 for(const m of facts.mgr_remarks??[])out.push(`${(m.role??'Line manager')==='Line manager'?"THEIR LINE MANAGER'S":"ANOTHER APPROVER'S"} OVERALL REMARK (${fence(m.author)}): <<<${fence(m.remark)}>>>`);
 for(const t of facts.trail??[])out.push(`HOW IT REACHED YOU: the ${t.label} (${fence(t.by)}) placed them at ${t.band?plainBands[t.band]:'not rated'} overall (it came in ${t.from?'at '+plainBands[t.from]+' overall':'with no rating yet'}). ${t.note.trim()?'Their note: <<<'+fence(t.note)+'>>>':'No note given.'}`);
 const readable=facts.rows.flatMap(r=>r.file_list).filter(f=>texts.get(f.id)?.status==='ok').length,budget=Math.max(1500,Math.min(6000,Math.floor(16000/Math.max(1,readable))));
 for(const r of facts.rows){
  out.push('',`KPI: ${r.kpi}`,`  Weight ${sourceFigure(r.weight,2)}% · ${r.direction}${r.unit?' · unit '+r.unit:''}`);
  if(r.scale)out.push('  Rating scale, lowest to highest: '+r.scale);if(r.target!=null)out.push('  Target: '+r.target);
  out.push(`  Keyed result: ${r.result} -- ${where(r)}`);
  if(r.moderation.length)for(const m of r.moderation)out.push(`  THEIR LINE MANAGER'S MODERATION (${fence(m.by)}): moved the result from ${m.from_res} to ${m.to_res} -- ${where({...r,value:m.to,band:r.mod_band??r.band})}. ${m.why?'Their reason: <<<'+fence(m.why)+'>>>':'No reason given.'}`);
  else if(r.locked&&r.approvers.length)out.push(`  Their line manager (${fence(r.approvers.join(', '))}) approved the result as entered.`);
  else if(r.mod_band&&r.mod_band!==r.band)out.push("  The manager's moderation so far puts it at a different level from theirs.");
  out.push(r.note?'  Their note: <<<'+fence(r.note)+'>>>':'  Their note: none.');if(!r.file_list.length)out.push('  Supporting files: none.');
  for(const f of r.file_list){const tx=texts.get(f.id),head=`  Supporting file <<<${fence(f.name)}>>>${f.note?' described as <<<'+fence(f.note)+'>>>':''}`;
   if(tx?.status==='ok'){const body=Array.from(tx.text).length<=budget?tx.text:Array.from(tx.text).slice(0,budget).join('')+'\n[... more not shown]',modCheck=r.mod_value!=null?`; the moderated figure ${r.mod_result} ${evidenceFigureInText(r.mod_value,tx.text)?'APPEARS':'does NOT appear'} in it`:'';out.push(`${head} -- the server's check: the keyed figure ${r.result} ${evidenceFigureInText(r.value,tx.text)?'APPEARS':'does NOT appear'} in it${modCheck}.`,`    CONTENTS${tx.method==='vision'?' (transcribed from an image)':''}:\n<<<\n${fence(body)}\n>>>`);}
   else{const why:Record<string,string>={no_text:'it has no readable text -- it may be a scan',unsupported:"that file type can't be read",too_big:'it is too large or too complex to read',unreadable:"the file couldn't be opened",unread:"it hasn't been read yet",retry:"it hasn't been read yet"};out.push(`${head} -- its contents could not be read (${why[tx?.status??'unread']??'not read'}).`);}
  }
 }
 for(const h of facts.hr??[])out.push('',`SET BY HR, not the person's own result (do not assess it): ${h.kpi}.`);return out.join('\n');
}
const normalizeCode=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase().replace(/[ -]/g,'_'):'';
const justifications=new Set(['yes','partly','no']),verdicts=new Set(['well_justified','partly_justified','not_justified']),modelEvidence=new Set(['supports','partly','contradicts','not_shown']);
const object=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function matchKpi(name:unknown,rows:InsightRow[]){const n=String(name??'').replace(/\s+/g,' ').trim().toLowerCase();if(!n)return null;for(const key of [n,n.split(' (')[0].trim()]){const found=rows.find(r=>r.kpi.trim().toLowerCase()===key);if(found)return found;}return rows.filter(r=>r.kpi&&n.startsWith(r.kpi.trim().toLowerCase())).sort((a,b)=>b.kpi.length-a.kpi.length)[0]??null;}
function restate(text:string,verdict:InsightVerdict|null){if(!verdict)return text;const word=verdict.replaceAll('_',' ');return text.replace(/\b(?:(?:only|just|fully|well|partly|partially|mostly|largely|not)[\s_]+)+justified\b/gi,m=>m[0]===m[0].toUpperCase()?word[0].toUpperCase()+word.slice(1):word);}
function caseBottom(text:string,verdict:InsightVerdict|null){
 if(!verdict)return text;const want={well_justified:'well',partly_justified:'partly',not_justified:'not'}[verdict],split=text.search(/[:.](?:\s|$)/),head=(split<0?text:text.slice(0,split)).toLowerCase(),rest=split<0?'':text.slice(split);
 const got=/(?:\bnot|n['’]t)\s+(?:fully|entirely|completely|all)\b|\b(?:only\s+)?(?:partly|partially|in part)\b/.test(head)?'partly':/\b(?:not|never)\b|n['’]t\b/.test(head)?'not':/\b(?:fully|well|clearly|largely|mostly|borne out|bears? out|backed|supported|justified)\b/.test(head)?'well':null;
 if(got==null||got===want)return text;return {well_justified:'The evidence bears out their results',partly_justified:'The evidence only partly bears out their results',not_justified:"The evidence doesn't bear out their results as they stand"}[verdict]+rest;
}
/** Every free-text field, figure, direction, cause, file claim and verdict passes deterministic checks. */
export function adjudicatePerformanceInsight(facts:InsightFacts,texts:Map<string,EvidenceText>,raw:string,source=performanceCaseText(facts,texts),extra=''):{ok:true;insight:PerformanceInsight}|{ok:false;reason:string}{
 let obj:Record<string,unknown>|null=null;
 try{if(raw.length>64000)return {ok:false,reason:'Assessment too large.'};const s=raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,''),start=s.indexOf('{'),end=s.lastIndexOf('}');obj=object(JSON.parse(s.slice(start,end+1)));}catch{/* Refuse malformed provider output. */}
 if(!obj)return {ok:false,reason:'Not a JSON object.'};
 const rows=facts.rows,names=[...rows.map(r=>r.kpi),...facts.hr?.map(h=>h.kpi)??[]],own=[facts.remark,...rows.map(r=>r.note),...rows.flatMap(r=>r.file_list.map(f=>f.note))].join(' '),rev=[...facts.mgr_remarks?.map(m=>m.remark)??[],...rows.flatMap(r=>r.moderation.map(m=>m.why)),...facts.trail?.filter(t=>!/^\s*(Moved to fit the calibration curve|Set on their own results)/.test(t.note)).map(t=>t.note)??[]].join(' '),reviewerNames=[...facts.mgr_remarks?.map(m=>m.author)??[],...rows.flatMap(r=>r.moderation.map(m=>m.by)),...facts.trail?.map(t=>t.by)??[]];
 const counts=new Set([rows.length,rows.reduce((n,r)=>n+r.file_list.length,0),rows.filter(r=>r.moderation.length).length,rows.filter(r=>insightGroup(r)==='well').length,rows.filter(r=>insightGroup(r)==='short').length]);
 const numberWords=vocabulary._IDP_NUMWORD as Record<string,string>,initials=names.map(n=>(n.match(/[A-Za-z]+/g)??[]).map(w=>w[0]).join('').toUpperCase()).join(' ')+' '+[...counts].flatMap(c=>[String(c),numberWords[String(c)]??'']).join(' ');
 const extra2=`${extra} KPI KPIs ${initials} ${extra.split(/\s+/).filter(w=>/^[A-Za-z]/.test(w)).map(w=>w+"'s").join(' ')} ${insightWordForms(source+' '+own)}`,evidence=new Map(rows.map(r=>[r.id,insightEvidence(r,texts,undefined,'',true)[0]]));
 function check(value:unknown,limit:number,kpi?:InsightRow,ask=false){
  if(value!=null&&typeof value!=='string')throw Error('Expected assessment text.');const text=String(value??'').replace(/\s+/g,' ').trim();if(!text)return '';if(text.split(/\s+/).length>limit)throw Error('Assessment text is too long.');
  const error=insightTextGroundingError(source,extra2,text)||insightBandError(text,source,names)||insightClaimError(text,rows,evidence,{kpi,ownWords:own,reviewerWords:rev,reviewerNames,ask});if(error)throw Error(error);return text;
 }
 try{
  let paragraph=check(obj.paragraph,facts.reviewer_kind==='calibrator'?160:110),read=check(obj.overall,80);if(!paragraph||!read)return {ok:false,reason:'Missing overall assessment.'};
  const got=new Map<string,{read:string;ev:string;note:string;justified?:InsightJustification;why:string}>();
  for(const value of Array.isArray(obj.kpis)?obj.kpis:[]){const k=object(value);if(!k)continue;const r=matchKpi(k.kpi,rows);if(!r||got.has(r.id))continue;
   const jc=normalizeCode(k.justified);got.set(r.id,{read:check(k.read,55,r),ev:normalizeCode(k.evidence),note:check(k.evidence_note,40,r),justified:justifications.has(jc)?jc as InsightJustification:undefined,why:check(k.why,35,r)});
  }
  if(!got.size)return {ok:false,reason:'No assigned KPI assessed.'};
  let discuss=(Array.isArray(obj.discuss)?obj.discuss:[]).slice(0,3).map(d=>check(d,28,undefined,true)).filter(Boolean);const modelWhy=check(obj.verdict_why,70),vm=normalizeCode(obj.verdict),kpis=plainPerformanceInsight(facts,texts).kpis;
  for(let i=0;i<rows.length;i++){const r=rows[i],g=got.get(r.id),[ev,note]=insightEvidence(r,texts,g?.ev as InsightEvidence,g?.note??'');if(g&&modelEvidence.has(g.ev)&&ev!==g.ev)return {ok:false,reason:'The model file verdict does not hold against its contents.'};kpis[i]={...kpis[i],read:g?.read||kpis[i].read,evidence:ev,evidence_note:note};}
  const result=applyInsightAssessment(kpis,facts,texts,{kpis:Object.fromEntries([...got].map(([id,g])=>[id,{justified:g.justified,why:g.why}])),verdict:verdicts.has(vm)?vm as InsightVerdict:undefined,verdict_why:modelWhy});
  if(verdicts.has(vm)&&result.verdict&&result.verdict!==vm){paragraph=restate(paragraph,result.verdict);read=restate(read,result.verdict);}if(facts.reviewer_kind==='calibrator')paragraph=caseBottom(paragraph,result.verdict);
  let steps=result.steps;const clean=steps.filter(s=>s.startsWith('Nothing to query'));if(clean.length){const asks=discuss.filter(s=>!/^\s*(?:accept|take)\b/i.test(s));steps=steps.filter(s=>!clean.includes(s)).concat(asks.length?[]:clean);discuss=asks;}
  return {ok:true,insight:{paragraph,read,kpis,verdict:result.verdict,verdict_why:result.verdict_why,discuss:mergeInsightDiscuss(steps,discuss,rows.map(r=>r.kpi))}};
 }catch(error){return {ok:false,reason:error instanceof Error?error.message:'Assessment did not pass its checks.'};}
}
