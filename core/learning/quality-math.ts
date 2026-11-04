/** AI v2 Phase 2, P2-6 — the AI quality page's arithmetic. Pure: no database, no clock, no model.
 *
 * THE FIGURES (every one a share of counts, shown with its counts; none is a ratio of HR staff to employees):
 *  - Answers marked helpful: answers marked helpful / answers marked at all (helpful or not helpful).
 *  - Prepared actions confirmed unchanged, edited, discarded: each / the prepared actions people decided. A decided
 *    prepared action is a card prepared in chat that was confirmed as prepared, opened to edit or discarded, or a loop card
 *    a person completed with the value it proposed or with a changed one (core/loops/types.ts LoopResolution as_prepared or
 *    changed). A loop card that proposed no value of its own (completed) has nothing to change and is left out; a loop card
 *    cannot be discarded. So the three shares add up to the whole.
 *  - Open gaps: the intents asked about in the period whose status is open, with the share of the period's gap questions
 *    that wait on them.
 *  - The trend: the confirmed-unchanged share of each month's decided prepared actions.
 * A share with no denominator is null ("no data yet"), never 0. */
import {chartMonths,periodStartDate} from '../capacity/ledger-math';
import type {GapStatus,LearningRole,QualityPeriod,SignalKind} from './types';

export {chartMonths,periodStartDate};
export type SignalFact=Readonly<{companyId:string;kind:SignalKind;date:string;count:number}>;
export type LoopCardFact=Readonly<{companyId:string;resolution:'as_prepared'|'changed';date:string;count:number}>;
export type GapFact=Readonly<{companyId:string;intentKey:string;role:LearningRole;date:string;count:number}>;
/** The current status of an intent in a company; an intent with no status is open. */
export type GapStatusFact=Readonly<{companyId:string;intentKey:string;status:GapStatus;duplicateOf:string|null}>;

export type Share=Readonly<{part:number;whole:number;share:number|null}>;
const share=(part:number,whole:number):Share=>Object.freeze({part,whole,share:whole>0?part/whole:null});

export type QualityFigures=Readonly<{
 helpful:Share;
 prepared:Readonly<{decided:number;unchanged:Share;edited:Share;discarded:Share;
  /** How the decided total splits between chat cards and loop cards. */
  chatCards:number;loopCards:number}>;
 gaps:Readonly<{openIntents:number;questions:number;openQuestions:Share}>;
 trend:readonly Readonly<{month:string;unchanged:number;decided:number;share:number|null}>[];
}>;

const sum=<T>(rows:readonly T[],pick:(row:T)=>number)=>rows.reduce((total,row)=>total+pick(row),0);
const statusKey=(companyId:string,intentKey:string)=>companyId+'\u0000'+intentKey;

/** The figures for `period` ending `today` (Malaysia calendar days), over the facts given (already narrowed to the
 * companies in the filter). Facts outside the period count only towards the trend's months. */
export function computeQuality(input:Readonly<{period:QualityPeriod;today:string;signals:readonly SignalFact[];loopCards:readonly LoopCardFact[];
 gaps:readonly GapFact[];statuses:readonly GapStatusFact[]}>):QualityFigures{
 const from=periodStartDate(input.period,input.today),months=chartMonths(input.period,input.today);
 const inPeriod=(date:string)=>date>=from&&date<=input.today;
 const signals=input.signals.filter(row=>inPeriod(row.date)),loops=input.loopCards.filter(row=>inPeriod(row.date)),gaps=input.gaps.filter(row=>inPeriod(row.date));
 const count=(kind:SignalKind)=>sum(signals.filter(row=>row.kind===kind),row=>row.count);
 const helpful=count('answer_helpful'),marked=helpful+count('answer_unhelpful');
 const confirmed=count('card_confirmed'),edited=count('card_edited'),discarded=count('card_discarded');
 const asPrepared=sum(loops.filter(row=>row.resolution==='as_prepared'),row=>row.count),changed=sum(loops.filter(row=>row.resolution==='changed'),row=>row.count);
 const chatCards=confirmed+edited+discarded,loopCards=asPrepared+changed,decided=chatCards+loopCards;
 const status=new Map(input.statuses.map(row=>[statusKey(row.companyId,row.intentKey),row.status]));
 const isOpen=(row:GapFact)=>(status.get(statusKey(row.companyId,row.intentKey))??'open')==='open';
 const openIntents=new Set(gaps.filter(isOpen).map(row=>statusKey(row.companyId,row.intentKey))).size;
 const questions=sum(gaps,row=>row.count),openQuestions=sum(gaps.filter(isOpen),row=>row.count);
 const trend=months.map(month=>{
  const at=(date:string)=>date.slice(0,7)===month;
  const unchanged=sum(input.signals.filter(row=>at(row.date)&&row.kind==='card_confirmed'),row=>row.count)
   +sum(input.loopCards.filter(row=>at(row.date)&&row.resolution==='as_prepared'),row=>row.count);
  const all=sum(input.signals.filter(row=>at(row.date)&&(row.kind==='card_confirmed'||row.kind==='card_edited'||row.kind==='card_discarded')),row=>row.count)
   +sum(input.loopCards.filter(row=>at(row.date)),row=>row.count);
  return Object.freeze({month,unchanged,decided:all,share:all>0?unchanged/all:null});
 });
 return Object.freeze({
  helpful:share(helpful,marked),
  prepared:Object.freeze({decided,unchanged:share(confirmed+asPrepared,decided),edited:share(edited+changed,decided),discarded:share(discarded,decided),chatCards,loopCards}),
  gaps:Object.freeze({openIntents,questions,openQuestions:share(openQuestions,questions)}),
  trend:Object.freeze(trend),
 });
}

/** Small groups (Phase 2 integration, 4 November 2026): a gap's role bands, locale and days are given only for an intent
 * at least this many distinct logins asked in the companies and period shown (counted by the database over the askers' own
 * notes, app.teras_gap_detailed_intents, which never names one); otherwise the intent and count only. */
export const GAP_DETAIL_MIN_ASKERS=5;
export type GapRow=Readonly<{intentKey:string;kind:string;area:string;count:number;
 /** At least GAP_DETAIL_MIN_ASKERS distinct logins asked it: only then are `roles`, `firstSeen` and `lastSeen` given. */
 detailed:boolean;
 /** The role bands that asked it; null for a small group. */
 roles:readonly LearningRole[]|null;
 /** The first and last Malaysian day it was asked in the period (YYYY-MM-DD); null for a small group. A gap keeps no
  * words and no time finer than the day (AI v2 Phase 2 hardening). */
 firstSeen:string|null;lastSeen:string|null;
 /** Each company's current status, for the companies where the intent was asked in the period. */
 statuses:readonly Readonly<{companyId:string;status:GapStatus;duplicateOf:string|null}>[];
 /** One status when every company agrees, else null (mixed). */
 status:GapStatus|null;rank:number}>;
/** The gap backlog: the period's gap questions grouped by intent, counted and ranked (most asked first, then the most
 * roles affected, then the intent key), with each company's status. `detailed` names the intents at least
 * GAP_DETAIL_MIN_ASKERS distinct logins asked (none when omitted): any other intent gives its intent and count only, and
 * its roles never order it (it ranks as if it had none). */
export function gapBacklog(input:Readonly<{period:QualityPeriod;today:string;gaps:readonly GapFact[];statuses:readonly GapStatusFact[];
 detailed?:ReadonlySet<string>}>):readonly GapRow[]{
 const from=periodStartDate(input.period,input.today);
 const rows=input.gaps.filter(row=>row.date>=from&&row.date<=input.today);
 const status=new Map(input.statuses.map(row=>[statusKey(row.companyId,row.intentKey),row]));
 const groups=new Map<string,{count:number;roles:Set<LearningRole>;companies:Set<string>;first:string;last:string}>();
 for(const row of rows){
  const group=groups.get(row.intentKey)??{count:0,roles:new Set<LearningRole>(),companies:new Set<string>(),first:row.date,last:row.date};
  group.count+=row.count;group.roles.add(row.role);group.companies.add(row.companyId);
  if(row.date<group.first)group.first=row.date;if(row.date>group.last)group.last=row.date;groups.set(row.intentKey,group);
 }
 return Object.freeze([...groups].map(([intentKey,group])=>{
  const [kind,area]=intentKey.split(':');
  const statuses=[...group.companies].sort().map(companyId=>{const row=status.get(statusKey(companyId,intentKey));
   return Object.freeze({companyId,status:row?.status??'open' as GapStatus,duplicateOf:row?.duplicateOf??null});});
  const distinct=new Set(statuses.map(row=>row.status+'\u0000'+(row.duplicateOf??'')));
  const detailed=input.detailed?.has(intentKey)===true;
  return {intentKey,kind,area,count:group.count,detailed,roles:detailed?Object.freeze([...group.roles].sort()):null,firstSeen:detailed?group.first:null,
   lastSeen:detailed?group.last:null,statuses:Object.freeze(statuses),status:distinct.size===1?statuses[0].status:null};
 }).sort((a,b)=>b.count-a.count||(b.roles?.length??0)-(a.roles?.length??0)||a.intentKey.localeCompare(b.intentKey))
  .map((row,index)=>Object.freeze({...row,rank:index+1})));
}

/** A loop's corrections by month: at Prepare, its cards completed with a changed value of all completed with or without
 * a change; above Prepare, its automatic actions people changed or undid of all it applied (P2-1's demotion signal). */
export type LoopCorrectionFact=Readonly<{loop:string;companyId:string;month:string;decided:number;corrected:number}>;
export type LoopCorrectionRow=Readonly<{loop:string;months:readonly Readonly<{month:string;decided:number;corrected:number;share:number|null}>[]}>;
export function loopCorrectionTrend(facts:readonly LoopCorrectionFact[],months:readonly string[]):readonly LoopCorrectionRow[]{
 const loops=[...new Set(facts.map(row=>row.loop))].sort();
 return Object.freeze(loops.map(loop=>Object.freeze({loop,months:Object.freeze(months.map(month=>{
  const rows=facts.filter(row=>row.loop===loop&&row.month===month);
  const decided=sum(rows,row=>row.decided),corrected=sum(rows,row=>row.corrected);
  return Object.freeze({month,decided,corrected,share:decided>0?corrected/decided:null});
 }))})));
}
