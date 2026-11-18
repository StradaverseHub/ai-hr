import {z} from 'zod';
import source from './idp-fit-source.json';
import {insightTextGroundingError} from './insight-grounding';
import type {PMBand,PotentialBand} from './model';
export type IdpFitFacts={goals:{area:string;text:string}[];no_action:string[];direction:string;step_text:string;developing:string[];weak_kpis:string[];pm_self:PMBand|null;pm_mod:PMBand|null;tm_self:PotentialBand|null;tm_mod:PotentialBand|null;self_ahead:boolean;has_kpis:boolean;pm_lines:{kpi:string;self:PMBand|null;mod:PMBand|null}[]};
export type IdpFitInsight={v:2;kind:'idp_fit';verdict:'not_yet'|'partly_fits'|'fits';verdict_why:string;discuss:string[];paragraph:string;scores:string};
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),stop=new Set(source._IDP_FIT_STOP),words=(s:string)=>new Set((s.toLowerCase().match(/[a-z]{4,}/g)??[]).filter(w=>!stop.has(w))),stepUp=new RegExp(source._IDP_STEP_UP_RE,'i');
export function plainIdpFit(first:string,f:IdpFitFacts,mine=true):IdpFitInsight {
 let verdict:IdpFitInsight['verdict']='fits',why='';const whys:string[]=[],steps:string[]=[];
 if(!f.goals.length){verdict='not_yet';why=`${first}'s plan has no goals yet.`;steps.push(`Agree two or three goals with ${first}, each with an action and a date.`);}
 else{
  if(f.no_action.length){verdict='partly_fits';whys.push(`${f.no_action.slice(0,2).join(', ')} has no actions yet`);steps.push(`Add a concrete action and a date to ${f.no_action[0]}.`);}
  const goalText=f.goals.map(g=>g.text).join(' ').toLowerCase(),terms=words(goalText),needs=[...f.developing,...f.weak_kpis],covered=needs.filter(n=>{const nw=words(n);return nw.size?[...nw].filter(w=>terms.has(w)).length*2>=nw.size:!n.trim()||new RegExp(`\\b${escape(n.trim().toLowerCase())}\\b`).test(goalText);});
  if(needs.length&&!covered.length){verdict='partly_fits';whys.push(`no goal works on ${needs.slice(0,2).join(', ')}`);steps.push(`Add a goal on ${needs[0]}.`);}
  if(!f.direction){verdict='partly_fits';whys.push('no direction is stated');steps.push(`Ask ${first} where they want to be in one to three years.`);}
  else if(stepUp.test(f.step_text)&&['UA','BE'].includes(f.pm_mod??'')){verdict='not_yet';whys.push("the step they aim for is ahead of this year's moderated results");steps.push(`Talk through what ${first} needs to show first before that step.`);}
  if(f.self_ahead){if(verdict==='fits')verdict='partly_fits';whys.push(`their own view of the year runs ahead of ${mine?'your moderation':"the line manager's moderation"}`);steps.push(mine?`Talk through where your view and ${first}'s differ.`:`Check where the line manager's view and ${first}'s differ.`);}
  if(f.has_kpis&&!f.pm_lines.length){if(verdict==='fits')verdict='partly_fits';whys.push("their KPI results aren't in for this reading yet");steps.push(`Look again once ${first}'s KPI results are in.`);}
  if(verdict==='fits'){why=`The goals work on ${covered.length?covered.slice(0,2).join(', '):'the areas they are developing'}, and the direction builds on this year's results.`;steps.push("Agree the support you'll give and check progress mid-year.");}
  else why=whys[0][0].toUpperCase()+whys[0].slice(1)+(whys.length>1?'; '+whys.slice(1,3).join('; '):'')+'.';
 }
 const areas=f.goals.map(g=>g.area).filter(Boolean),parts:string[]=[],scores:string[]=[];
 if(areas.length)parts.push(`${first}'s plan has ${areas.length} goal${areas.length===1?'':'s'}: ${areas.slice(0,3).join('; ')}.`);
 if(f.direction)parts.push(`Where they want to go: ${f.direction.slice(0,160).replace(/[ .;,]+$/,'')}.`);
 if(f.developing.length)parts.push(`Still developing: ${f.developing.slice(0,3).join(', ')}.`);
 if(!parts.length)parts.push(why);
 if(f.pm_self)scores.push(`KPIs: their view ${source.PM_LABEL_NAMES[f.pm_self]} → ${mine?'your moderation':"line manager's moderation"} ${f.pm_mod?source.PM_LABEL_NAMES[f.pm_mod]:'not yet'}`);
 if(f.tm_self)scores.push(`Competency: their view ${f.tm_self} → ${mine?'your review':"line manager's review"} ${f.tm_mod??'not yet'}`);
 return {v:2,kind:'idp_fit',verdict,verdict_why:why,discuss:steps.slice(0,3),paragraph:parts.join(' '),scores:scores.join(' · ')};
}
const ratingAdvice=/\b(rais\w*|lower\w*|mov(?:e|es|ed|ing)|bump\w*|upgrad\w*|downgrad\w*|deserv\w*|increas\w*|reduc\w*|higher)\b[^.]{0,40}\b(rating|rung|band|score|grade|level)\b|\b(rating|rung|band|score|grade)\b[^.]{0,25}\b(higher|lower|up|down|raised)\b/i;
const response=z.object({paragraph:z.string(),verdict:z.string(),verdict_why:z.string().optional(),discuss:z.array(z.string()).max(3).optional()});
/** An optimistic AI verdict rejects the entire answer; it cannot sit beneath a stricter server badge. */
export function adjudicateIdpFit(first:string,facts:IdpFitFacts,caseText:string,extra:string,raw:string):IdpFitInsight|null {
 let json:unknown;try{json=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));}catch{return null;}
 const parsed=response.safeParse(json);if(!parsed.success)return null;
 const clean=(s:string)=>s.replace(/\s+/g,' ').trim(),obj=parsed.data,paragraph=clean(obj.paragraph),why=clean(obj.verdict_why??''),steps=(obj.discuss??[]).map(clean).filter(Boolean),verdict=clean(obj.verdict).toLowerCase().replaceAll(' ','_'),rank=['not_yet','partly_fits','fits'],base=plainIdpFit(first,facts);
 const bad=(text:string,max:number)=>!text||text.split(/\s+/).length>max||/\d+(?:\.\d+)?\s*%|\bscore[sd]?\b/i.test(text)||/\b(?:promot\w*|salary|pay rise|bonus|deserv\w*)\b/i.test(text)||ratingAdvice.test(text)||/\b(?:unacceptable|below expectations?|meets? expectations?|above expectations?|met (?:\w+ )?expectations?|exceed(?:s|ed|ing)? (?:\w+ )?expectations?|outstanding)\b/i.test(text)||/\b(?:UA|BE|ME|AE|OU)\b/.test(text)||insightTextGroundingError(caseText,extra,text,{vocabulary:source._IDP_FIT_VOCAB,starters:source._IDP_FIT_STARTERS});
 if(rank.indexOf(verdict)<0||rank.indexOf(verdict)>rank.indexOf(base.verdict)||bad(paragraph,120)||why&&bad(why,70)||steps.some(s=>bad(s,28)))return null;
 return {...base,paragraph,verdict:verdict as IdpFitInsight['verdict'],verdict_why:why||base.verdict_why,discuss:[...new Set([...base.discuss,...steps])].slice(0,3)};
}

/** The same fit read from the BG seat: instructions remain addressed to the line manager. */
export function talentIdpFit(data:IdpFitInsight):IdpFitInsight {
 return {...data,scores:data.scores.replace(/\byour (moderation|review)\b/g,"their line manager's $1"),verdict_why:data.verdict_why.replace(/\byour moderation\b/g,"their line manager's moderation"),discuss:data.discuss.map(step=>step.replace(/^Agree the support you'll give and check progress/,"Their line manager agrees the support they'll give and checks progress").replace(/^Talk through where your view and (.+?)'s differ\./,"Their line manager talks through where their view and $1's differ.")).filter(step=>! /\byou(?:r|'ll|'re|'ve)?\b/i.test(step))};
}
