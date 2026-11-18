import {z} from 'zod';
import {screenPerformanceQuestion} from './guide-screen';
/** Dashboard guidance is read-only. These refusals run before retrieval or any model call. */
const rater=new RegExp("\\bwho\\b.{0,40}\\b(rated|rate|scored|score|assessed|assess|reviewed|gave|give|wrote|said|commented)\\b.{0,40}\\b(me|my)\\b|\\b(name|names|identity|identify)\\b.{0,30}\\b(rater|raters|assessor|assessors|reviewers?)\\b|\\bwhich\\b.{0,20}\\b(rater|raters|assessor|assessors|colleague|peer|peers)\\b",'i');
const scoring=new RegExp("(?=.*(\\b(360|three.?sixty|competenc\\w*|potential|bands?|ratings?|scores?|talent status|performance|kpis?|grades?)\\b|(?!)))(?=.*(\\bcalculat\\w*|\\bcomput\\w*|\\bwork(?:ed|s)? out\\b|\\bderiv\\w*|\\bformula\\w*|\\bweight\\w*|\\bthresholds?\\b|\\bcut.?offs?\\b|\\bsplit\\b|\\bbreak.?down\\b|\\bscoring\\b|\\bscored\\b|\\bpoints?\\b|\\bpercentage\\b|\\bmethod\\w*|\\bwhat (?:score|average|mark|rating) do (?:i|you|we) need\\b|\\bcontribut\\w*|\\bfeeds? into\\b|\\bcounts? (?:towards|toward|for)\\b|\\bmade up of\\b|\\bhow (?:do|does|did|will|would|much)\\b.{0,50}\\baffects?\\b|\\bhow (?:is|are|was|were|do|does|did)\\b.{0,40}\\b(?:decided|determined|arrived at|made up|counted|added up|marked|graded|measured)\\b))",'is'),scoringMethod=new RegExp("(?=.*(\\bcalculat\\w*|\\bcomput\\w*|\\bwork(?:ed|s)? out\\b|\\bderiv\\w*|\\bformula\\w*|\\bweight\\w*|\\bthresholds?\\b|\\bcut.?offs?\\b|\\bsplit\\b|\\bbreak.?down\\b|\\bscoring\\b|\\bscored\\b|\\bpoints?\\b|\\bpercentage\\b|\\bmethod\\w*|\\bwhat (?:score|average|mark|rating) do (?:i|you|we) need\\b|\\bcontribut\\w*|\\bfeeds? into\\b|\\bcounts? (?:towards|toward|for)\\b|\\bmade up of\\b|\\bhow (?:do|does|did|will|would|much)\\b.{0,50}\\baffects?\\b|\\bhow (?:is|are|was|were|do|does|did)\\b.{0,40}\\b(?:decided|determined|arrived at|made up|counted|added up|marked|graded|measured)\\b))",'is');
export function performanceQuestionRefusal(question:string){
 if(rater.test(question))return {kind:'rater' as const,text:'I can’t tell you who rated you: 360 feedback is anonymous. Your report shows the combined feedback once HR releases it.'};
 if(scoring.test(question)||/\b(?:UA|BE|ME|AE|OU)\b/.test(question)&&scoringMethod.test(question))return {kind:'scoring' as const,text:'I can’t explain how 360 and competency are scored or how bands are calculated. Your line manager or HR can talk you through your own result.'};
 const kind=screenPerformanceQuestion(question);
 if(kind)return {kind,text:kind==='injection'?'I can’t change how I work or share my instructions. I can help with your Performance review and record.':kind==='not_allowed'?'I can only answer questions about your own Performance record and where to find things. Changes and approvals follow the review steps.':'That’s outside what I can help with. Ask about your review, your record or where to find something in Performance.'};
 return null;
}
export type PerformanceGuideFact={id:string;label:string;text:string;href:string;source:'Your dashboard'|'Your record'|'Performance guide'};
export const performanceGuideSelection=z.object({facts:z.array(z.string()).max(4),unanswered:z.boolean()}).strict();
/** Only pre-authorized facts and links can leave the guide, never model-authored claims or URLs. */
export function resolvePerformanceGuideSelection(raw:unknown,facts:PerformanceGuideFact[]){
 const parsed=performanceGuideSelection.safeParse(raw);if(!parsed.success)return null;
 const ids=[...new Set(parsed.data.facts)];if(ids.some(id=>!facts.some(f=>f.id===id)))return null;
 return {facts:ids.map(id=>facts.find(f=>f.id===id)!),unanswered:parsed.data.unanswered||!ids.length};
}
export function performanceGuideMatches(question:string,facts:PerformanceGuideFact[]){
 const words=(question.toLowerCase().match(/[a-z0-9]+/g)??[]).filter(w=>w.length>=3&&!new Set(['the','what','how','can','you','your','about','where','when','does','have','for','that','this','with','please']).has(w));
 const past=/\b(?:last|previous|prior|past|history|historical)\b/i.test(question),current=/\bcurrent\b/i.test(question);
 return facts.map((fact,i)=>({fact,i,score:words.reduce((n,w)=>n+Number(`${fact.label} ${fact.text}`.toLowerCase().includes(w)),0)+(past&&fact.id.startsWith('history:')?words.length+1:0)+(current&&fact.id.startsWith('current:')?words.length+1:0)})).filter(r=>r.score).sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,4).map(r=>r.fact);
}

/** Bound provider context for large teams, retaining relevant people and personal record facts first. */
export function performanceGuideContext(question:string,facts:PerformanceGuideFact[]){
 const selected=[...performanceGuideMatches(question,facts),...facts.filter(f=>f.id==='dashboard'||f.id.startsWith('summary:')||f.source==='Your record'||f.source==='Performance guide'),...facts];
 return selected.filter((f,i)=>selected.findIndex(x=>x.id===f.id)===i).slice(0,120);
}
