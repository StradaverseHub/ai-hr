import {z} from 'zod';
import reference from './written-remarks-source.json';
import {insightTextGroundingError} from './insight-grounding';
import type {InsightFacts} from './performance-insight-model';
export const writtenAxisSchema=z.enum(['pm','pot']);
export type WrittenAxis=z.infer<typeof writtenAxisSchema>;
export type WrittenRemark={role:'self'|'lm'|'hod'|'buceo'|'bg'|'group';who:string;on:string|null;move:string|null;text:string;src?:string};
const trailSchema=z.object({tier:z.string(),label:z.string(),by:z.string(),from:z.string().nullable(),band:z.string().nullable(),note:z.string()});
export const writtenSourceSchema=z.object({name:z.string(),tier:z.string(),status:z.string().nullable(),selfRemark:z.string(),managerRemark:z.string(),managerName:z.string(),competencies:z.array(z.object({title:z.string(),future:z.boolean(),selfRemark:z.string(),managerRemark:z.string()})),trail:z.array(trailSchema)});
const labels:Record<WrittenRemark['role'],string>={self:'Their own',lm:"Their line manager's",hod:"The HOD's",buceo:"The BU CEO's",bg:"The BG CEO's",group:"The Group's"};
const short=(text:string)=>{const words=text.trim().split(/\s+/);return words.slice(0,30).join(' ').replace(/[,;:]+$/,'')+(words.length>30?'…':'');};
export const writtenRemarksSource=(entries:WrittenRemark[])=>entries.map(e=>`${e.src||`${labels[e.role]} ${e.on?`note on ${e.on}`:e.move?`remark when they ${e.move.replaceAll('→','to')}`:'competency remark'}`}: <<<${e.text.replaceAll('<<<','‹‹‹').replaceAll('>>>','›››')}>>>`).join('\n');
export function plainWrittenRemarks(entries:WrittenRemark[]){
 const bits=entries.filter(e=>!e.on).map(e=>{const mv=e.move?` (${e.move})`:'';const who={self:'They wrote',lm:'Their line manager wrote',hod:`The HOD${mv} wrote`,buceo:`The BU CEO${mv} wrote`,bg:`The BG CEO${mv} wrote`,group:`The Group${mv} wrote`};return `${who[e.role]}: “${short(e.text)}”`;});
 return bits.length?bits.join(' '):entries.length?`Only notes on individual competencies so far (${entries.length}).`:'No written remarks yet.';
}
export const tidyWrittenRemarks=(text:string)=>text.replace(new RegExp(reference._POT_REMARKS_NONE_RE,'gi'),'').replace(/\s{2,}/g,' ').trim();
export function writtenRemarksError(entries:WrittenRemark[],name:string,axis:WrittenAxis,text:string){
 if(new RegExp(reference._POT_REMARKS_ADVICE_RE,'i').test(text))return 'Says what the rating should be.';
 const src=writtenRemarksSource(entries),numbers=[...src.matchAll(/(?<![\d.])(\d{1,2})(?![\d.])/g)].map(m=>Number(m[1])).filter(n=>n<=20).map(n=>reference._SMALL_NUMBER_WORDS[n]);
 const extra=[name.trim().split(/\s+/)[0]||'They','HOD','Low','Mid','High',...entries.flatMap(e=>[e.on??'',e.who,e.move??'']),...(axis==='pm'?[...Object.values(reference.PM_LABEL_NAMES),...Object.keys(reference.PM_LABEL_NAMES),'KPI','KPIs']:[]),...numbers,...(/\bmil\b/i.test(src)?['million']:[])].join(' ');
 return insightTextGroundingError(src,extra,text,{vocabulary:reference._POT_REMARKS_VOCAB,starters:reference._POT_SUMMARY_STARTERS});
}
function trailRemarks(trail:z.infer<typeof trailSchema>[],axis:WrittenAxis):WrittenRemark[]{
 return trail.filter(t=>t.note.trim()).map(t=>{const from=t.from||'',band=t.band||'',move=from===band?`kept ${band}`:!from?`set ${band}`:`moved ${from} → ${band}`,nm=(b:string)=>(reference.PM_LABEL_NAMES as Record<string,string>)[b]??b;
 return {role:t.tier==='bu'?'buceo':t.tier==='bg'?'bg':t.tier==='group'||t.tier==='final'?'group':'hod',who:t.label+(t.by?` — ${t.by}`:''),on:null,move,text:t.note.trim(),...(axis==='pm'?{src:`The ${t.label}'s remark when they ${from===band?`kept them at ${nm(band)}`:!from?`set them at ${nm(band)}`:`moved them from ${nm(from)} to ${nm(band)}`}`}:{})};});
}
export function potentialWrittenRemarks(s:z.infer<typeof writtenSourceSchema>):WrittenRemark[]{
 const out:WrittenRemark[]=[];
 if(['submitted','reviewed'].includes(s.status??'')){
  if(s.selfRemark.trim())out.push({role:'self',who:'Their own remark',on:null,move:null,text:s.selfRemark.trim()});
  for(const c of s.competencies)if(c.selfRemark.trim())out.push({role:'self',who:'Their own note',on:`${c.title} (${c.future?'next':'current'} level)`,move:null,text:c.selfRemark.trim()});
  if(s.status==='reviewed'){
   if(s.managerRemark.trim())out.push({role:'lm',who:'Their line manager'+(s.managerName?` — ${s.managerName}`:''),on:null,move:null,text:s.managerRemark.trim()});
   for(const c of s.competencies)if(c.managerRemark.trim())out.push({role:'lm',who:"Their line manager's note",on:`${c.title} (${c.future?'next':'current'} level)`,move:null,text:c.managerRemark.trim()});
  }
 }
 return [...out,...trailRemarks(s.trail,'pot')];
}
export function performanceWrittenRemarks(f:InsightFacts):WrittenRemark[]{
 const out:WrittenRemark[]=[];
 if(f.remark.trim())out.push({role:'self',who:'Their overall remark',on:null,move:null,text:f.remark.trim(),src:'Their own overall remark'});
 for(const r of f.rows)if(r.note.trim())out.push({role:'self',who:'Their note',on:r.kpi,move:null,text:r.note.trim(),src:`Their own note on ${r.kpi}`});
 for(const m of f.mgr_remarks??[]){const lm=m.role==='Line manager';if(m.remark.trim())out.push({role:'lm',who:`${lm?'Their line manager':'Approver'} — ${m.author}`,on:null,move:null,text:m.remark.trim(),src:lm?"Their line manager's overall remark":"Another approver's overall remark"});}
 for(const r of f.rows)for(const m of r.moderation)if(m.why.trim())out.push({role:'lm',who:`Moderation — ${m.by||'their line manager'}`,on:r.kpi,move:`${m.from_res} → ${m.to_res}`,text:m.why.trim(),src:`Their line manager's reason for moderating ${r.kpi} from ${m.from_res} to ${m.to_res}`});
 return [...out,...trailRemarks(f.trail??[],'pm')];
}
