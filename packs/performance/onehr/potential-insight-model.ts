import {z} from 'zod';
import {competencySchema} from './model';
import {insightTextGroundingError} from './insight-grounding';
import reference from './potential-insight-source.json';
export const potentialInsightSourceSchema=z.object({name:z.string(),valid:z.boolean(),raters:z.number().int(),minimum:z.number().int(),principles:z.array(z.object({name:z.string(),description:z.string(),yes:z.number(),total:z.number(),comments:z.array(z.string())})),remarks:z.array(z.string()),competencyStatus:z.string().nullable(),competencyRemark:z.string(),managerRemark:z.string(),competencies:z.array(competencySchema.pick({text:true,skillTitle:true,principle:true,future:true,self:true,manager:true,managerRemark:true}))});
export type PotentialInsightSource=z.infer<typeof potentialInsightSourceSchema>;
export type PotentialInsight={paragraph:string};
const sorted=(xs:string[])=>[...xs].sort((a,b)=>a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0);
const fence=(text:string)=>text.replaceAll('<<<','‹‹‹').replaceAll('>>>','›››');
/** Unweighted, unrounded agreement describes themes; the canonical potential calculation alone owns bands. */
export function potentialInsightFacts(s:PotentialInsightSource){
 const lines:string[]=[],strong:string[]=[],dev:string[]=[],down:string[]=[],up:string[]=[],titles:string[]=[];
 if(s.valid){
  for(const p of s.principles){if(!p.total)continue;const word=p.yes/p.total>=.75?'strong':p.yes/p.total>=.4?'mixed':'developing';if(word==='strong')strong.push(p.name);if(word==='developing')dev.push(p.name);
   lines.push(`${p.name} (${p.description}): raters' view -- ${word}`);for(const comment of sorted(p.comments.filter(c=>c.trim())))lines.push(`  a rater comment on ${p.name}: <<<${fence(comment)}>>>`);
  }
  for(const remark of sorted(s.remarks.filter(c=>c.trim())))lines.push(`A rater's overall remark: <<<${fence(remark)}>>>`);
  if(s.competencyStatus==='reviewed'){
   const groups=new Map<string,PotentialInsightSource['competencies']>();for(const c of s.competencies){const key=c.principle||'area';groups.set(key,[...(groups.get(key)??[]),c]);}
   for(const [category,rows] of groups){const label=(c:typeof rows[number])=>`${c.skillTitle??c.text} (${c.future?'next':'current'} level)`,effective=(c:typeof rows[number])=>c.manager??c.self,changed=rows.filter(c=>c.manager!==null&&c.manager!==c.self),dn=sorted([...new Set(changed.filter(c=>effective(c)!=='yes').map(label))]),upl=sorted([...new Set(changed.filter(c=>effective(c)==='yes').map(label))]),share=rows.filter(c=>effective(c)==='yes').length/rows.length;
    down.push(...dn);up.push(...upl);titles.push(...rows.map(c=>c.skillTitle??c.text));
    lines.push(`Competency ${category} (reviewed by their line manager): ${share>=.75?'demonstrated in most':share>=.4?'in some':'still developing'}${dn.length?`; their line manager's review moved ${dn.join(', ')} to still developing`:''}${upl.length?`; their line manager's review moved ${upl.join(', ')} up to demonstrated`:''}`);
    for(const c of rows)if(c.managerRemark?.trim())lines.push(`  their line manager's note on ${label(c)}: <<<${fence(c.managerRemark)}>>>`);
   }
  }else if(s.competencyStatus)lines.push('Competency assessment: not reviewed by their line manager yet.');
  if(s.competencyRemark)lines.push(`Their own competency remark: <<<${fence(s.competencyRemark)}>>>`);
  if(s.competencyStatus==='reviewed'&&s.managerRemark)lines.push(`Their line manager's competency remark: <<<${fence(s.managerRemark)}>>>`);
 }
 return {valid:s.valid,raters:s.raters,min_valid:s.minimum,letter:s.minimum===1,strong,dev,tc_status:s.competencyStatus,tc_moved_down:sorted([...new Set(down)]),tc_moved_up:sorted([...new Set(up)]),tc_mgr_remark:s.competencyStatus==='reviewed'?s.managerRemark.trim():'',source:lines.join('\n'),extra:[s.name,...s.principles.map(p=>p.name),...titles].join(' ')};
}
export type PotentialInsightFacts=ReturnType<typeof potentialInsightFacts>;
export function plainPotentialInsight(f:Omit<PotentialInsightFacts,'source'|'extra'>):string{
 if(!f.valid)return `Not enough 360 feedback yet for an insight — ${f.raters||0} of the ${f.min_valid||'?'} raters needed have submitted.`;
 const bits:string[]=[];
 if(f.letter)bits.push("At their grade the 360 is their line manager's rating alone.");
 if(f.strong.length)bits.push(`Raters saw them strongest on ${f.strong.slice(0,3).join(', ')}.`);
 if(f.dev.length)bits.push(`Less consistently on ${f.dev.slice(0,3).join(', ')}.`);
 if(!f.strong.length&&!f.dev.length)bits.push("Raters' views were mixed across the principles.");
 if(f.tc_status==='reviewed'){
  bits.push('Their competency assessment has been reviewed by their line manager.');
  if(f.tc_moved_down.length)bits.push(`On review, their line manager moved ${f.tc_moved_down.slice(0,3).join(', ')} to still developing.`);
  if(f.tc_moved_up.length)bits.push(`On review, their line manager moved ${f.tc_moved_up.slice(0,3).join(', ')} up to demonstrated.`);
  if(f.tc_mgr_remark){const words=f.tc_mgr_remark.split(/\s+/);bits.push(`Their line manager's competency remark: “${words.slice(0,28).join(' ').replace(/[,;:]+$/,'')}${words.length>28?'…':''}”`);}
 }else if(f.tc_status)bits.push("Their competency assessment is not reviewed yet, so it doesn't count toward the band.");
 return bits.join(' ');
}
export function potentialInsightError(f:PotentialInsightFacts,text:string){
 const without360=text.replace(/\b360\b/g,'');
 if(/\d/.test(without360))return 'A number.';
 if(new RegExp(reference._POT_SUMMARY_FORBIDDEN_RE,'i').test(without360))return 'Reviewer attribution, a count or a rating.';
 return insightTextGroundingError('Their 360 feedback. '+f.source,f.extra,text,{vocabulary:reference._POT_SUMMARY_VOCAB,starters:reference._POT_SUMMARY_STARTERS,ratio:.45,floor:8});
}
