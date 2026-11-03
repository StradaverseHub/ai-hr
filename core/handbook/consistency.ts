/** AI v2 Phase 2 hardening — what a policy's text STATES about an enforceable setting, and whether that agrees with
 * what the system enforces (pure: no database, no model, no amount worked out).
 *
 * Why: a version whose values were all rejected, or never read, could publish "RM 1.00 per km" while the claims service
 * enforces RM 0.60, and drift only looked at confirmed values. So every enforceable figure the text states is collected
 * here, from two places:
 *  1. a fresh deterministic read of the text, where one is possible: mileage rates written as "RM x per km" (or
 *     "RMx/km", "RM x a kilometre"), and claim submission windows written as "within N days" in a sentence about
 *     submitting or claiming (its claim type when the sentence names exactly one; otherwise the claim type of a value
 *     read from the same words; otherwise every claim type). Leave entitlements have no deterministic reading: their
 *     words say too little on their own;
 *  2. every value read from the current text that is NOT confirmed (rejected or undecided), unless the deterministic
 *     read already covers its words.
 * A statement agrees when each of its figures is one the system enforces for that setting: a mileage rate of one of
 * the table's bands, the window's days, a day count of one of the entitlement table's ranges. The comparison is between
 * numbers written in the text and the owner's own setting; nothing is calculated. */
import type {PolicySpan} from './extract';
import {POLICY_SETTINGS,type EntitlementBandValue,type MileageBandValue,type PolicySetting,type SettingBody,type SettingTarget} from './types';

export type PolicyStatement=Readonly<{setting:PolicySetting;target:SettingTarget|null;figures:readonly number[];quote:string;start:number;end:number;
 source:'text'|'value';valueId:string|null;confirmedWords:boolean}>;
export type StatedValue=Readonly<{id:string;setting:PolicySetting;target:SettingTarget;value:SettingBody;spans:readonly PolicySpan[];decision:'confirmed'|'rejected'|null}>;
export type ClaimTypeName=Readonly<{code:string;name:string}>;
export type PolicyDisagreement=Readonly<{statement:PolicyStatement;target:SettingTarget;enforced:SettingBody|null}>;

const RATE=/\b(?:RM|MYR)\s?(\d+(?:\.\d+)?)\s*(?:\/|per|a|for each|each)\s*(?:km|kilomet(?:re|er)s?)\b/gi;
const WITHIN=/\bwithin\s+(\d{1,4})\s+(?:calendar\s+)?days?\b/gi;
const ABOUT_CLAIMS=/\b(?:submit\w*|submission|claim\w*|file|filed|filing)\b/i;
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const names=(sentence:string,type:ClaimTypeName)=>[type.code,type.name].some(word=>word.trim().length>=2&&new RegExp(`(^|[^\\p{L}\\p{N}])${escape(word.trim())}($|[^\\p{L}\\p{N}])`,'iu').test(sentence));
/** The sentence around [start,end): from the previous ".", "!", "?" or line break to the next one. */
function sentenceAt(text:string,start:number,end:number){
 let from=start;while(from>0&&!/[.!?\n]/.test(text[from-1]!))from--;
 let to=end;while(to<text.length&&!/[.!?\n]/.test(text[to]!))to++;
 return text.slice(from,to);
}

/** The deterministic read: each mileage rate and claim submission window the text states, with its exact words. */
export function readStatedFigures(text:string,settings:readonly PolicySetting[],claimTypes:readonly ClaimTypeName[]):PolicyStatement[]{
 const out:PolicyStatement[]=[];
 if(settings.includes('claims.mileage_rates'))for(const m of text.matchAll(RATE)){
  const figure=Number(m[1]);if(!Number.isFinite(figure)||m.index===undefined)continue;
  out.push(Object.freeze({setting:'claims.mileage_rates',target:Object.freeze({}),figures:Object.freeze([figure]),quote:m[0],start:m.index,end:m.index+m[0].length,source:'text',valueId:null,confirmedWords:false} satisfies PolicyStatement));
 }
 if(settings.includes('claims.submit_within_days'))for(const m of text.matchAll(WITHIN)){
  if(m.index===undefined)continue;
  const sentence=sentenceAt(text,m.index,m.index+m[0].length);if(!ABOUT_CLAIMS.test(sentence))continue;
  const named=claimTypes.filter(type=>names(sentence,type));
  out.push(Object.freeze({setting:'claims.submit_within_days',target:named.length===1?Object.freeze({claimType:named[0]!.code}):null,figures:Object.freeze([Number(m[1])]),
   quote:m[0],start:m.index,end:m.index+m[0].length,source:'text',valueId:null,confirmedWords:false} satisfies PolicyStatement));
 }
 return out.sort((a,b)=>a.start-b.start);
}

/** The figures a value states, for comparison: mileage rates, the window's days, or the entitlement days. */
export function figuresOf(setting:PolicySetting,value:SettingBody):number[]{
 if(setting==='claims.submit_within_days')return [(value as {days:number}).days];
 if(setting==='claims.mileage_rates')return (value as {bands:readonly MileageBandValue[]}).bands.map(b=>b.ratePerKm);
 return (value as {bands:readonly EntitlementBandValue[]}).bands.map(b=>b.days);
}
const overlaps=(a:{start:number;end:number},b:{start:number;end:number})=>a.start<b.end&&b.start<a.end;
/** The spans of a value whose words carry the figures this module compares (rates, days). */
const figureSpans=(value:StatedValue)=>value.spans.filter(span=>span.part==='days'||/^band\.\d+\.(rate|days)$/.test(span.part));

/** Every enforceable figure a version's current text states: the deterministic read, plus each value read from the
 * text that is not confirmed and that the deterministic read does not already cover. A text statement whose words are a
 * confirmed value's own is marked (`confirmedWords`): drift reports that value itself. */
export function policyStatements(text:string,settings:readonly PolicySetting[],claimTypes:readonly ClaimTypeName[],values:readonly StatedValue[]):PolicyStatement[]{
 const read=readStatedFigures(text,settings,claimTypes).map(statement=>{
  const under=values.filter(v=>v.setting===statement.setting&&v.spans.some(span=>overlaps(span,statement)));
  const target=statement.target??under.find(v=>v.target.claimType)?.target??null;
  return Object.freeze({...statement,target,confirmedWords:under.some(v=>v.decision==='confirmed')});
 });
 const fromValues=values.filter(v=>v.decision!=='confirmed').filter(v=>{
  const spans=figureSpans(v);
  return !(spans.length>0&&spans.every(span=>read.some(s=>s.setting===v.setting&&overlaps(span,s))));
 }).map(v=>{
  const first=[...v.spans].sort((a,b)=>a.start-b.start)[0];
  return Object.freeze({setting:v.setting,target:v.target,figures:Object.freeze(figuresOf(v.setting,v.value)),quote:v.spans.map(s=>s.quote).join(' … '),
   start:first?.start??0,end:first?.end??0,source:'value' as const,valueId:v.id,confirmedWords:false});
 });
 return [...read,...fromValues].sort((a,b)=>a.start-b.start);
}

/** The settings a version mentions: those its text states a figure for, and those a value was read for. */
export function mentionedSettings(statements:readonly PolicyStatement[],values:readonly StatedValue[]):PolicySetting[]{
 const found=new Set<PolicySetting>([...statements.map(s=>s.setting),...values.map(v=>v.setting)]);
 return POLICY_SETTINGS.filter(setting=>found.has(setting));
}

const same=(a:number,b:number)=>Math.abs(a-b)<1e-9;
/** Each statement against what the system enforces (`enforced`: the owner's setting for a target, or for an unapproved
 * version the value it would apply). A window stated for no particular claim type is held against every claim type. */
export function disagreements(statements:readonly PolicyStatement[],enforced:(setting:PolicySetting,target:SettingTarget)=>SettingBody|null,
 claimTypeCodes:readonly string[]):PolicyDisagreement[]{
 const out:PolicyDisagreement[]=[];
 for(const statement of statements){
  const targets:SettingTarget[]=statement.target?[statement.target]:statement.setting==='claims.submit_within_days'?claimTypeCodes.map(code=>({claimType:code})):[{}];
  for(const target of targets){
   const value=enforced(statement.setting,target);
   const held=value===null?[]:figuresOf(statement.setting,value);
   if(value===null||!statement.figures.every(figure=>held.some(h=>same(h,figure))))out.push(Object.freeze({statement,target:Object.freeze({...target}),enforced:value}));
  }
 }
 return out;
}

/** A key for a (setting, target) pair, the same for equal targets whatever their key order or code case. */
export const settingKey=(setting:PolicySetting,target:SettingTarget)=>`${setting}|${(target.claimType??'').trim().toUpperCase()}|${(target.leaveType??'').trim().toUpperCase()}`;
