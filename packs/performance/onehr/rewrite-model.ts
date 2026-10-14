import { z } from 'zod';
import { sourceFigure } from './source-numeric';

export const assessmentRewriteTarget=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('kpi_note'),id:z.uuid()}).strict(),
 z.object({kind:z.literal('kpi_justification'),id:z.uuid()}).strict(),
 z.object({kind:z.enum(['pm_self_remark','pm_manager_remark','tc_self_remark','tc_manager_remark'])}).strict(),
 z.object({kind:z.enum(['tc_self_item','tc_manager_item']),id:z.string().min(1).max(100)}).strict(),
 z.object({kind:z.enum(['tc_self_section','tc_manager_section']),principle:z.string().min(1).max(200)}).strict(),
 z.object({kind:z.literal('feedback_comment'),contextId:z.uuid(),principle:z.string().min(1).max(200)}).strict(),
 z.object({kind:z.literal('feedback_remark'),contextId:z.uuid()}).strict(),
 z.object({kind:z.literal('idp_action'),area:z.string().trim().max(200),mode:z.enum(['onJob','fromOthers','formalLearning'])}).strict(),
]);
export type AssessmentRewriteTarget=z.infer<typeof assessmentRewriteTarget>;

// The migrated rewrite guard permits light rewording, but no invented figures or unsupported clauses.
const stop=new Set(["about", "action", "after", "also", "always", "been", "before", "being", "colleague", "could", "does", "done", "during", "each", "every", "from", "have", "into", "just", "like", "made", "make", "many", "more", "most", "much", "only", "other", "over", "really", "remark", "result", "should", "situation", "some", "such", "task", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "very", "well", "were", "what", "when", "where", "which", "while", "will", "with", "would", "your"]);
const numberWords=new Set(["billion", "dozen", "dozens", "eight", "eighteen", "eighty", "eleven", "fifteen", "fifty", "five", "forty", "four", "fourteen", "hundred", "hundreds", "million", "millions", "nine", "nineteen", "ninety", "seven", "seventeen", "seventy", "six", "sixteen", "sixty", "ten", "thirteen", "thirty", "thousand", "thousands", "three", "twelve", "twenty", "two"]);
function normalize(word:string){
 let value=word.toLowerCase().replaceAll('’',"'");
 if(value.endsWith("'s"))value=value.slice(0,-2);
 value=value.replace(/^'+|'+$/g,'');
 for(const suffix of ['ing','ed','es','ly','s'])if(value.endsWith(suffix)&&value.length-suffix.length>=3){value=value.slice(0,-suffix.length);break;}
 if(value.endsWith('e')&&value.length>3)value=value.slice(0,-1);
 return value;
}
const words=(text:string)=>(text.toLowerCase().match(/[a-z][a-z'’]*/g)??[]).filter(word=>word.length>=4&&!stop.has(word));
function numbers(text:string){
 const out=new Set<string>();
 for(const match of text.match(/\d[\d,]*(?:\.\d+)?/g)??[]){
  const value=Number(match.replaceAll(',',''));
  const rounded=Number.isFinite(value)?sourceFigure(value,4)!:value;
  out.add(Number.isInteger(rounded)&&Number.isFinite(rounded)?BigInt(rounded).toString():String(rounded));
 }
 for(const word of text.toLowerCase().match(/[a-z]+/g)??[])if(numberWords.has(word))out.add(word);
 return out;
}
const nonAsciiWords=(text:string)=>Array.from(new Intl.Segmenter(undefined,{granularity:'word'}).segment(text),part=>part.isWordLike&&/[^\x00-\x7F]/.test(part.segment)?part.segment.normalize('NFKC').toLowerCase():'').filter(Boolean);
export function adjudicateAssessmentRewrite(draft:string,instruction:string,context:string,text:string,{forwardLooking=false}:{forwardLooking?:boolean}={}):{ok:true;text:string}|{ok:false;reason:'empty'|'invalid'|'figures'|'details'}{
 const result=text.trim();
 if(!result||result.length>4000)return {ok:false,reason:'invalid'};
 if(forwardLooking)return {ok:true,text:result};
 if(!draft.trim())return {ok:false,reason:'empty'};
 const source=[draft,instruction,context].join(' '),knownNumbers=numbers(source);
 if([...numbers(result)].some(value=>!knownNumbers.has(value)))return {ok:false,reason:'figures'};
 const content=words(result),known=new Set(words(source).map(normalize));
 if(new Set(content.filter(word=>!known.has(normalize(word)))).size>Math.max(3,Math.floor(content.length*.45)))return {ok:false,reason:'details'};
 // The source only tokenizes ASCII. Apply the same bounded novelty rule to the other supported scripts.
 const unicode=nonAsciiWords(result),knownUnicode=new Set(nonAsciiWords(source));
 if(new Set(unicode.filter(word=>!knownUnicode.has(word))).size>Math.max(3,Math.floor(unicode.length*.45)))return {ok:false,reason:'details'};
 return {ok:true,text:result};
}
