import vocabulary from './insight-vocabulary.json';
import { sourceFigure } from './source-numeric';
import { insightGroup,type InsightRow } from './performance-insight-model';

const stop=new Set(vocabulary._RG_STOP),numWords=new Set(vocabulary._RG_NUMWORDS),starters=new Set(vocabulary._PERF_SUMMARY_STARTERS),vocab=vocabulary._PERF_SUMMARY_VOCAB.split(/\s+/),generic=new Set(vocab.map(norm));
function norm(word:string){let w=word.toLowerCase().replaceAll('’',"'").replace(/'s$/,'').replace(/^'+|'+$/g,'');for(const suffix of ['ing','ed','es','ly','s'])if(w.endsWith(suffix)&&w.length-suffix.length>=3){w=w.slice(0,-suffix.length);break;}return w.endsWith('e')&&w.length>3?w.slice(0,-1):w;}
function words(text:string){return (text.toLowerCase().match(/[a-z][a-z'’]*/g)??[]).filter(w=>w.length>=4&&!stop.has(w));}
function numbers(text:string){return new Set([...(text.match(/\d[\d,]*(?:\.\d+)?/g)??[]).map(n=>sourceFigure(Number(n.replaceAll(',','')),4)),...(text.toLowerCase().match(/[a-z]+/g)??[]).filter(w=>numWords.has(w))]);}
function roots(word:string){const out=new Set<string>();for(const suffix of ['ness','ment','ing','ed','es','ly','s'])if(word.endsWith(suffix)&&word.length-suffix.length>=3){const base=word.slice(0,-suffix.length);out.add(base);out.add(base+'e');if(base.length>=4&&base.at(-1)===base.at(-2))out.add(base.slice(0,-1));}return out;}
const intersects=(a:Set<string>,b:Set<string>)=>[...a].some(w=>b.has(w));
const bare=(word:string)=>word.replace(/['’]s$/,'').replace(/^['’\-]+|['’\-]+$/g,'').toLowerCase();
/** Inflections of existing words are allowed; this never contributes a new stem or a number. */
export function insightWordForms(text:string){
 const out=new Set<string>(),low=text.toLowerCase(),months:Record<string,string>={jan:'january',feb:'february',mar:'march',apr:'april',jun:'june',jul:'july',aug:'august',sep:'september',sept:'september',oct:'october',nov:'november',dec:'december'};
 for(const month of low.match(/\b(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/g)??[])out.add(months[month]);
 for(const word of new Set(low.match(/[a-z]{5,}/g)??[])){
  let base=word;for(const suffix of ['ations','ation','ions','ion','ments','ment','ing','ed','es','e','s'])if(word.endsWith(suffix)&&word.length-suffix.length>=4){base=word.slice(0,-suffix.length);break;}
  for(const suffix of ['ation','ations','ion','ions','tion','tions','ment','ments','ing','ed','e','es','s'])out.add(base+suffix);
 }
 return [...out].sort().join(' ');
}
export function insightTextGroundingError(source:string,extra:string,text:string,options?:{vocabulary:string;starters:string[]}){
 const vocab=(options?.vocabulary??vocabulary._PERF_SUMMARY_VOCAB).split(/\s+/),starters=new Set(options?.starters??vocabulary._PERF_SUMMARY_STARTERS);
 if(!text.trim())return 'empty';if(text.trim().split(/\s+/).length>120)return 'too long';
 const all=source+' '+extra+' '+vocab.join(' '),have=new Set(words(all).map(norm)),content=words(text),novel=new Set(content.filter(w=>!have.has(norm(w)))),knownNumbers=numbers(all);
 if([...numbers(text)].some(n=>!knownNumbers.has(n)))return 'Invented figure.';
 if(novel.size>Math.max(6,Math.trunc(content.length*.4)))return 'Unsupported wording.';
 const known=new Set((source+' '+extra).match(/[A-Za-z][A-Za-z'’\-]*/g)?.map(bare)??[]),knownOrVocab=new Set([...known,...vocab]);
 for(const match of text.matchAll(/\b([A-Z][A-Za-z'’\-]+|[A-Z]{2,})\b/g)){
  const tok=bare(match[1]),before=text.slice(0,match.index).trimEnd().replace(/['’]+$/,''),start=!before||'.!?:"('.includes(before.at(-1)!);
  if(start){if(starters.has(tok)||vocab.includes(tok)||known.has(tok)||intersects(roots(tok),knownOrVocab))continue;const parts=tok.split('-').filter(Boolean);if(parts.length>1&&parts.every(p=>starters.has(p)||knownOrVocab.has(p)||intersects(roots(p),knownOrVocab)))continue;return 'Invented name.';}
  if(!known.has(tok)&&!intersects(roots(tok),known)){const parts=tok.split('-').filter(Boolean);if(parts.length>1&&parts.every(p=>knownOrVocab.has(p)||intersects(roots(p),known)))continue;return 'Invented name.';}
 }
 return null;
}
const positive=/\b(beat|beats|beating|surpass\w*|outperform\w*|strong|stronger|strongest|better than (?:the |its |their )?target|ahead of (?:the |its |their )?target)\b/gi;
const negative=/\b(missed|misses|fell short|falls short|short of (?:the |its |their )?target|underperform\w*|weak|weaker|weakest|worse than (?:the |its |their )?target|behind (?:the |its |their )?target)\b/gi;
const attributed=/\b(says?|said|claims?|claimed|wrote|writes|remark|note|notes|according|describes?|described|believes?|reports?|reported)\b/i;
const reviewer=/\b(manager|managers|moderat(?:ed|ion|ions|ing)|HOD|BU CEO|reviewers?|approvers?|calibrat\w*|tier)\b/i;
const backs=/\b(backs|backed|supports|supported|confirms|confirmed|verifies|verified|matches|shows the same)\b/gi;
const negation=/\b(no|not|doesn't|does not|don't|isn't|without|neither|nor|never|fails? to|can't|cannot|nothing)\b/i;
const cause=/\b(because(?: of)?|due to|driven by|thanks to|owing to|as a result of|led to|caused by|on the back of|helped by|hit by|blam(?:e|es|ed|ing)|attribut\w+ (?:it |this )?to|credit(?:s|ed)? (?:it |this )?to)\s+([^.;:!?]+)/gi;
const advice=/\b(rais\w*|lower\w*|mov(?:e|es|ed|ing)|bump\w*|upgrad\w*|downgrad\w*|deserv\w*|increas\w*|reduc\w*|higher)\b[^.]{0,40}\b(rating|rung|band|score|grade|level)\b|\b(rating|rung|band|score|grade)\b[^.]{0,25}\b(higher|lower|up|down|raised)\b/gi;
const pastMove=/\b(moved|lowered|raised|reduced|increased|downgraded|upgraded|bumped|brought|took|pulled|pushed|marked|placed|put)\b/i;
const modal=/\b(should|could|would|worth|consider\w*|recommend\w*|suggest\w*|may|might|needs? to|warrant\w*|merit\w*|deserv\w*|ought)\b/i;
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function sentenceAt(text:string,index:number){const start=text.slice(0,index),offset=Math.max(start.lastIndexOf('. '),start.lastIndexOf('! '),start.lastIndexOf('? '),-2)+2;return text.slice(offset).split(/(?<=[.!?])\s/,1)[0];}
export function insightBandError(text:string,source:string,names:string[]){
 let t=text;for(const name of [...names].sort((a,b)=>b.length-a.length))if(name)t=t.replace(new RegExp(escape(name),'gi'),' ');
 for(const m of t.matchAll(/\b(unacceptable|below expectations?|meets? expectations?|above expectations?|met (?:\w+ )?expectations?|exceed(?:s|ed|ing)? (?:\w+ )?expectations?|outstanding|UA|BE|ME|AE|OU)\b/gi)){
  if(['ua','be','me','ae','ou'].includes(m[1].toLowerCase())&&m[1]!==m[1].toUpperCase())continue;
  const next=t.slice(m.index+m[0].length).match(/^\s+([A-Za-z]+)/);if(next&&source.toLowerCase().includes(`${m[1]} ${next[1]}`.toLowerCase()))continue;return 'The model stated a rating band.';
 }
 return null;
}
export function insightClaimError(text:string,rows:InsightRow[],evidence:Map<string,string>,{kpi,ownWords='',reviewerWords='',reviewerNames=[],ask=false}:{kpi?:InsightRow;ownWords?:string;reviewerWords?:string;reviewerNames?:string[];ask?:boolean}={}){
 for(const sent of text.split(/(?<=[.!?])\s+/))for(const clause of sent.split(/;|,\s*(?:and|but|while|whereas|although|though)\b|\s(?:but|while|whereas|although)\s/)){
  let spots=rows.flatMap(r=>r.kpi?Array.from(clause.toLowerCase().matchAll(new RegExp(escape(r.kpi.toLowerCase()),'g')),m=>({at:m.index,row:r})):[]);
  if(!spots.length&&kpi)spots=[{at:0,row:kpi}];if(!spots.length)continue;
  const nearest=(index:number)=>spots.reduce((a,b)=>Math.abs(a.at-index)<=Math.abs(b.at-index)?a:b).row;
  if(!attributed.test(sent))for(const [regex,bad,hiOnly] of [[positive,'short',false],[negative,'well',false],[/\babove (?:the |its |their )?target\b/gi,'short',true],[/\bbelow (?:the |its |their )?target\b/gi,'well',true]] as const){
   for(const m of clause.matchAll(regex)){const r=nearest(m.index);if(hiOnly&&r.direction!=='higher is better')continue;if(insightGroup(r)===bad&&!(r.moderation.length&&insightGroup({...r,value:r.mod_value??r.value,band:r.mod_band??r.band})!==bad))return 'The claimed direction conflicts with the target.';}
  }
  if(!ask&&!negation.test(clause)){
   const quant=/\b(?:backs|supports|confirms|backed|supported|confirmed)(?: by \w+(?: \w+)?)?\s+(?:both|all|each)\b|\b(?:both|all|each)\b(?:\s+\w+){0,3}?\s+(?:are|were|is|was)?\s*(?:backed|supported|confirmed)\b/i.test(clause);
   for(const m of clause.matchAll(backs)){const near=clause.slice(Math.max(0,m.index-40),m.index+m[0].length+40);if(/\b(manager|approver|HOD)\b/i.test(near)&&!/\b(file|files|sign-?off|report|sheet|document|attachment|evidence)\b/i.test(clause))continue;
    const about=quant?[...new Set(spots.map(s=>s.row))]:[nearest(m.index)];if(about.some(r=>!['supports','found','partly'].includes(evidence.get(r.id)??'')))return 'The file does not back this result.';
   }
  }
 }
 const own=new Set(words(ownWords+' '+insightWordForms(ownWords)).map(norm)),rev=new Set(words(reviewerWords+' '+insightWordForms(reviewerWords)).map(norm));
 for(const m of text.matchAll(cause)){
  const terms=words(m[2]).slice(0,8).filter(w=>!generic.has(norm(w)));if(terms.every(w=>own.has(norm(w))))continue;
  const sent=sentenceAt(text,m.index),asReviewer=reviewer.test(sent)||reviewerNames.some(n=>n.length>3&&sent.toLowerCase().includes(n.toLowerCase()));if(!(asReviewer&&terms.every(w=>own.has(norm(w))||rev.has(norm(w)))))return 'An unsupported cause was introduced.';
 }
 for(const m of text.matchAll(advice)){
  const sent=sentenceAt(text,m.index);if(!reviewer.test(sent)||modal.test(sent))return 'The model suggested changing the rating.';
  if(m[1]){if(!new RegExp('^'+pastMove.source+'$','i').test(m[1]))return 'The model suggested changing the rating.';}
  else if(!pastMove.test(text.slice(Math.max(0,m.index-40),m.index)))return 'The model suggested changing the rating.';
 }
 return null;
}
