import {z} from 'zod';
import source from './competency-insight-source.json';
import {insightTextGroundingError} from './insight-grounding';
import type {Competency} from './model';
export type CompetencyClaim=Pick<Competency,'text'|'skillTitle'|'principle'|'future'|'self'|'selfRemark'>;
export type CompetencyInsight={v:2;paragraph:string;verdict:'not_justified'|'partly_justified'|'well_justified'|null;verdict_why:string;discuss:string[]};
const words=(text:string)=>text.trim()?text.trim().split(/\s+/):[];
const names=(xs:string[])=>xs.length>1?`${xs.slice(0,-1).join(', ')} and ${xs.at(-1)}`:xs[0]??'';
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Current and next levels of one skill are one competency, not two conflicting claims. */
export function competencyInsightFacts(rows:CompetencyClaim[],remark:string){
 const levels=new Map<string,Map<boolean,string|null>>(),reasoned=new Set<string>(),lines:string[]=[];
 for(const row of rows){const title=(row.skillTitle??row.text).trim()||'a competency',level=levels.get(title)??new Map();level.set(row.future,row.self);levels.set(title,level);
  const reason=row.selfRemark?.trim()??'';
  if(row.self==='yes'&&words(reason).length>=5)reasoned.add(`${title}\0${row.future}`);
  lines.push(`Competency: ${title} (${row.principle?row.principle+', ':''}${row.future?'next':'current'} level) -- their answer: ${row.self==='yes'?'Demonstrate':row.self==='no'?'Developing':'not answered'}.${reason?' Their reason: '+reason:''}`);
 }
 const demo:string[]=[],dev:string[]=[],both:string[]=[],next_dev:string[]=[],next_only:string[]=[];
 for(const [title,level] of levels){const base=level.has(false)?level.get(false):level.get(true);
  if(base==='yes'){demo.push(title);if(level.has(false)&&level.get(true)==='yes')both.push(title);else if(level.has(false)&&level.get(true)==='no')next_dev.push(title);}
  else if(base==='no'){dev.push(title);if(level.has(false)&&level.get(true)==='yes')next_only.push(title);}
 }
 const both_unreasoned=both.filter(t=>!reasoned.has(`${t}\0true`)),next_unreasoned=[...levels].filter(([t,lv])=>lv.get(true)==='yes'&&!reasoned.has(`${t}\0true`)).map(([t])=>t);
 const contradicted=demo.filter(t=>new RegExp(`develop\\w*[^.]{0,60}${escape(t)}|${escape(t)}[^.]{0,40}develop`,'i').test(remark));
 if(remark.trim())lines.push('Their overall remark: '+remark.trim());
 return {total:levels.size,demonstrated:demo.length,demo,dev,both,next_dev,next_only,remark:remark.trim(),n_answers:rows.length,n_demo:rows.filter(r=>r.self==='yes').length,n_reasoned:reasoned.size,both_unreasoned,next_unreasoned,contradicted,source:lines.join('\n')};
}
export type CompetencyInsightFacts=ReturnType<typeof competencyInsightFacts>;
export function plainCompetencyInsight(first:string,f:CompetencyInsightFacts):CompetencyInsight{
 if(!f.total)return {v:2,paragraph:`${first} has no competencies to assess this cycle.`,verdict:null,verdict_why:'',discuss:[]};
 const short=(xs:string[])=>xs.slice(0,4).join(', ')+(xs.length>4?` and ${xs.length-4} more`:''),parts=[`By their own answers, ${first} demonstrates ${f.demonstrated} of ${f.total} competencies at their current level.`];
 for(const [label,items] of [['Demonstrate',f.demo],['At the next level too',f.both],['Still developing at the next level',f.next_dev],['Still developing',f.dev],['Marked the next level but not their current one',f.next_only]] as const)if(items.length)parts.push(`${label}: ${short(items)}.`);
 if(f.remark){const cut=f.remark.slice(0,160)+(f.remark.length>160?'…':'');parts.push(`Their remark: “${cut}”${/[.!?…]$/.test(cut)?'':'.'}`);}
 const nw=words(f.remark).length,bu=f.both_unreasoned,nu=f.next_unreasoned,why:string[]=[],discuss:string[]=[];let verdict:CompetencyInsight['verdict'];
 if(f.n_demo&&!f.n_reasoned&&f.n_demo/f.n_answers>=.8&&nw<20){verdict='not_justified';why.push(`They marked ${f.n_demo===f.n_answers?'all':'nearly all'} of their answers Demonstrate with no reason for any of them.`);}
 else if(bu.length>=2){verdict='not_justified';why.push(`They claim both levels of ${names(bu)} with no reason given.`);}
 else if(f.contradicted.length){verdict=bu.length||nu.length?'not_justified':'partly_justified';why.push(`Their remark says they are still developing ${names(f.contradicted)}, which they marked Demonstrate.`);if(bu.length||nu.length)why.push(`The next-level claims for ${names(bu.length?bu:nu)} come with no real reason.`);}
 else if(bu.length||nu.length||nw<20||f.n_demo&&f.n_reasoned*2<f.n_demo){verdict='partly_justified';if(bu.length||nu.length)why.push(`The next-level claims for ${names(bu.length?bu:nu)} come with no reason.`);if(f.n_demo&&f.n_reasoned*2<f.n_demo)why.push('Most of their Demonstrate answers have no reason behind them.');if(nw<20)why.push(`Their overall remark is ${nw?'brief':'missing'}.`);}
 else {verdict='well_justified';why.push('Their Demonstrate claims come with reasons, and their remark covers the period.');}
 for(const title of f.contradicted.slice(0,1))discuss.push(`Ask ${first} about ${title}: their remark says they are still developing it, but they marked Demonstrate.`);
 for(const title of (bu.length?bu:nu).slice(0,2))discuss.push(`Ask ${first} for an example of ${title} at the next level.`);
 if(verdict==='not_justified'&&!discuss.length)discuss.push(`Ask ${first} for examples before you confirm the Demonstrate answers.`);
 if(verdict==='well_justified')discuss.push('The claims are backed by their reasons -- you can confirm them as answered.');
 return {v:2,paragraph:parts.join(' '),verdict,verdict_why:why.join(' '),discuss};
}
const response=z.object({paragraph:z.string(),verdict:z.string().optional(),verdict_why:z.string().optional(),discuss:z.array(z.string()).max(3).optional()});
const forbidden=/\b(potential|band|bands|score|scores|scored|points?|percent\w*|deserv\w*|should be rated|rate (?:them|her|him) as|promot\w*|high performer|low performer)\b|%/i;
export function adjudicateCompetencyInsight(first:string,facts:CompetencyInsightFacts,raw:string):CompetencyInsight|null{
 let parsed:unknown;try{parsed=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{parsed={paragraph:raw};}
 const result=response.safeParse(parsed);if(!result.success)return null;
 const clean=(s:string)=>s.replace(/\s+/g,' ').trim(),obj=result.data,paragraph=clean(obj.paragraph),why=clean(obj.verdict_why??''),steps=(obj.discuss??[]).map(clean).filter(Boolean);
 const counts=[facts.n_answers,facts.n_demo,facts.n_answers-facts.n_demo,facts.total,facts.demo.length,facts.dev.length,facts.both.length,facts.next_dev.length],numberWords:Record<number,string>={0:'no',1:'one',2:'two',3:'three',4:'four',5:'five',6:'six',7:'seven',8:'eight',9:'nine',10:'ten',11:'eleven',12:'twelve',15:'fifteen',18:'eighteen',20:'twenty'};
 const extra=[first,...counts.flatMap(n=>[String(n),numberWords[n]??'']),...Array.from(facts.source.matchAll(/\d[\d,]*(?:\.\d+)?/g),m=>numberWords[Number(m[0].replaceAll(',',''))]??'')].join(' '),bad=(text:string,max:number)=>!text||words(text).length>max||forbidden.test(text)||insightTextGroundingError(facts.source,extra,text,{vocabulary:source._TC_SUMMARY_VOCAB,starters:source._TC_SUMMARY_STARTERS.split(/\s+/)});
 if(bad(paragraph,120)||why&&bad(why,70)||steps.some(s=>bad(s,28)))return null;
 const base=plainCompetencyInsight(first,facts),ranks=['not_justified','partly_justified','well_justified'],verdict=clean(obj.verdict??'').toLowerCase().replaceAll(' ','_'),rank=ranks.indexOf(verdict);
 if(base.verdict&&rank>=0&&rank<=ranks.indexOf(base.verdict)){base.verdict=verdict as CompetencyInsight['verdict'];base.verdict_why=why||base.verdict_why;}
 return {...base,paragraph,discuss:[...new Set([...base.discuss,...steps])].slice(0,3)};
}
