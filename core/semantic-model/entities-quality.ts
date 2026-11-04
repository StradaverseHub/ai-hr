/** AI v2 Phase 2 P2-6 — "how is AI Centre doing?", declared in the semantic model for HR and group administrators.
 *
 * One read, ai_quality_summary, over core/learning/quality.ts aiQuality, run as the caller for the companies they
 * administer: the AI quality page's figures exactly as the page shows them (each a percentage with its counts, for the
 * period), the most asked gap intents with their counts and status, and how many loop proposals wait for a decision.
 *
 * NEVER GIVEN: a redacted example, a correction's details, a name, a person, a company id, or any ratio of HR staff to
 * employees (none is computed). Every count and percentage is `bands` (ADR-0170 §2 principle 4: no exact figure leaves to the
 * provider); the person sees the exact figures after restoration. Intents are closed vocabularies. Pure declarations. */
import {provenanceField} from './entities-explain';
import {CAPABILITY_AREAS} from './entities-catalogue';
import type {DisclosureClass,FieldType,SemanticEntity,SemanticField,SemanticRead} from './types';

const f=(name:string,type:FieldType,disclosure:DisclosureClass,meaning:string,extra:Partial<Pick<SemanticField,'values'|'of'>>={}):SemanticField=>({name,type,disclosure,meaning,...extra});
const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};

export const AI_QUALITY_PERIODS=['last30','quarter','year'] as const;
export const AI_QUALITY_GAP_KINDS=['not_supported','no_route','cannot_answer'] as const;
export const AI_QUALITY_GAP_STATUSES=['open','planned','wont_do','duplicate','mixed'] as const;
const share=(name:string,meaning:string):SemanticField=>f(name,'object','full',meaning,{of:[
 f('percent','number','bands','The share as a percentage to one decimal place, as the page shows it; null when nothing was counted (say "no data yet", never 0).'),
 f('count','integer','bands','How many were counted in the share.'),
 f('of','integer','bands','Out of how many.')]});

export const QUALITY_ENTITIES:readonly SemanticEntity[]=freeze([
 {id:'ai_quality',label:'AI quality',
  meaning:'How people used AI Centre\'s answers and prepared actions, what it could not answer or do, and what the loops propose, for the companies an HR or group administrator administers: the AI quality page under AI Centre › Insights.',
  module:null,sensitivity:'ordinary',audience:'admin',rls:'administered_scope',owners:['core/learning/quality.ts#aiQuality'],
  // /assistant is never a link target: /ai-quality is the section's linkable address (it forwards to it).
  ruleVersion:null,relations:[],page:'/ai-quality',
  fields:[
   f('period','object','full','The period the figures cover.',{of:[f('name','enum','full','last30, quarter (this quarter) or year (this year).',{values:AI_QUALITY_PERIODS}),
    f('from','date','full','Its first day.'),f('to','date','full','Its last day (today).')]}),
   f('companies','integer','full','How many companies the figures cover: every company the caller administers.'),
   share('helpful','Answers marked helpful, out of the answers people marked helpful or not helpful.'),
   share('confirmedUnchanged','Prepared actions confirmed as AI Centre prepared them, out of the prepared actions people decided (cards in chat and loop cards).'),
   share('edited','Prepared actions opened to edit or changed, out of the same decided prepared actions.'),
   share('discarded','Prepared actions discarded, out of the same decided prepared actions.'),
   f('openGaps','object','full','Kinds of question AI Centre could not answer or do whose status is still open.',{of:[
    f('intents','integer','bands','How many such kinds of question are open.'),
    share('questions','The questions it could not meet that wait on an open kind, out of all it could not meet in the period.')]}),
   f('topGaps','list','full','The most asked kinds of question it could not answer or do, most asked first (at most five).',{of:[
    f('kind','enum','full','not_supported: asked whether it can do something, and it cannot yet; no_route: asked to do something it could not prepare; cannot_answer: any other question it could not answer.',{values:AI_QUALITY_GAP_KINDS}),
    f('area','enum','full','The product area the question was about.',{values:CAPABILITY_AREAS}),
    f('count','integer','bands','How many times it was asked in the period.'),
    f('status','enum','full','The administrators\' status for it: open, planned, wont_do (won\'t do), duplicate, or mixed (differs between companies).',{values:AI_QUALITY_GAP_STATUSES})]}),
   f('openProposals','integer','bands','Loop proposals waiting for an administrator to approve or reject on the AI quality page.'),
   provenanceField]},
] satisfies SemanticEntity[]);

export const QUALITY_READS:readonly SemanticRead[]=freeze([
 {name:'ai_quality_summary',entity:'ai_quality',
  purpose:'HR and group administrators only, for the companies they administer: how AI Centre is doing, as its AI quality page shows it. The share of answers people marked helpful, the share of prepared actions confirmed unchanged, edited or discarded, how many kinds of question it could not answer or do are still open and the most asked of them, and how many loop proposals wait for a decision. Each share comes as a percentage with its counts: give them as they are, never work one out. Use it for questions about AI Centre\'s quality, accuracy, usefulness, gaps or what people correct. It has no examples, names or people.',
  input:[{name:'period',identifier:false,optional:true,schema:{type:'string',enum:[...AI_QUALITY_PERIODS],description:'last30 (the default), quarter or year.'}}]},
] satisfies SemanticRead[]);
