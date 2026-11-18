/** Rewards Limit Controls (board fc804e8c). Pure and client-safe: no database, session or individual's pay.
 *
 * Every limit and threshold the annual review, the AI advisor and Rewards Analytics use has one stable typed key.
 * Group Rewards keeps one set of values per reward year as append-only versions; a saved version takes effect at
 * once (board 60f1fdcd retired the second-person confirmation). Draft reviews use the year's current version;
 * reviews past Draft keep the version they were submitted with until Group Rewards re-applies a newer one.
 *
 * Financial invariants are not configurable: no salary reduction (always Block), pools never fund each other or
 * another company, bonus payouts round down, and exemptions only ever relax budget caps. They are listed as fixed
 * rows so the page explains them, but a version can never carry a value or type for them.
 *
 * Values are integers: percentages and the CR floor in basis points (500 = 5%, 9000 = 0.90), bonus months in basis
 * points of a month (90000 = 9.00 months), MYR in cents, grades and years as whole numbers. */
import {z} from 'zod';
import type {RewardFlag,RewardPolicy} from './model';

export const rewardLimitTypes=['block','exception','warning','note'] as const;
export type RewardLimitType=typeof rewardLimitTypes[number];
export const rewardLimitAreas=['pools','person','bonus','lump','exemption','advisor'] as const;
export type RewardLimitArea=typeof rewardLimitAreas[number];
export type RewardLimitAppliesTo='standard'|'h'|'all';
export type RewardLimitUnit='percent'|'ratio'|'months'|'myr'|'grades'|'grade'|'years'|'points'|'none';

type Definition={
 key:string;area:RewardLimitArea;unit:RewardLimitUnit;appliesTo:RewardLimitAppliesTo;
 /** The baseline value (null = no value, or "none" where nullable). */
 value:number|null;type:RewardLimitType;
 /** Fixed rows explain a financial invariant and cannot be changed at all. */
 fixed?:boolean;
 /** The value can be edited (false for checks without a number). */
 valueEditable:boolean;
 /** The type can be edited (false for calculation settings, which are information only). */
 typeEditable:boolean;
 nullable?:boolean;min?:number;max?:number;
};
const d=(def:Definition)=>def;
/** The inventory, in page order. Baseline values and types are exactly the engine's behaviour before Limit Controls. */
export const rewardLimitDefinitions=[
 d({key:'pool.standard.merit',area:'pools',unit:'percent',appliesTo:'standard',value:500,type:'block',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'pool.standard.promotion',area:'pools',unit:'percent',appliesTo:'standard',value:100,type:'block',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'pool.standard.special',area:'pools',unit:'percent',appliesTo:'standard',value:100,type:'block',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'pool.h.merit',area:'pools',unit:'percent',appliesTo:'h',value:500,type:'block',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'pool.h.promotion',area:'pools',unit:'percent',appliesTo:'h',value:100,type:'block',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'pool.h.special',area:'pools',unit:'percent',appliesTo:'h',value:100,type:'block',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'pool.separate',area:'pools',unit:'none',appliesTo:'all',value:null,type:'block',fixed:true,valueEditable:false,typeEditable:false}),
 d({key:'increase.withoutPromotion',area:'person',unit:'percent',appliesTo:'all',value:1000,type:'warning',valueEditable:true,typeEditable:true,min:0,max:100000}),
 d({key:'increase.withPromotion',area:'person',unit:'percent',appliesTo:'all',value:3000,type:'warning',valueEditable:true,typeEditable:true,min:0,max:100000}),
 d({key:'promotion.increment',area:'person',unit:'percent',appliesTo:'all',value:1000,type:'exception',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'promotion.maxGrades',area:'person',unit:'grades',appliesTo:'all',value:3,type:'block',valueEditable:true,typeEditable:true,min:1,max:11}),
 d({key:'promotion.maxGrade',area:'person',unit:'grade',appliesTo:'all',value:23,type:'block',valueEditable:true,typeEditable:true,min:12,max:23}),
 d({key:'catchUp.crFloor',area:'person',unit:'ratio',appliesTo:'all',value:9000,type:'note',valueEditable:true,typeEditable:false,min:0,max:10000}),
 d({key:'salary.noReduction',area:'person',unit:'none',appliesTo:'all',value:null,type:'block',fixed:true,valueEditable:false,typeEditable:false}),
 d({key:'bonus.poolCap',area:'bonus',unit:'percent',appliesTo:'all',value:10000,type:'block',valueEditable:true,typeEditable:true,min:0,max:20000}),
 d({key:'bonus.underUse',area:'bonus',unit:'percent',appliesTo:'all',value:8000,type:'warning',valueEditable:true,typeEditable:true,min:0,max:10000}),
 d({key:'bonus.individualCeiling',area:'bonus',unit:'months',appliesTo:'all',value:90000,type:'exception',valueEditable:true,typeEditable:true,min:0,max:1000000}),
 d({key:'bonus.rounding',area:'bonus',unit:'none',appliesTo:'all',value:null,type:'note',fixed:true,valueEditable:false,typeEditable:false}),
 d({key:'bonus.individualMultiplier',area:'bonus',unit:'none',appliesTo:'all',value:null,type:'exception',valueEditable:false,typeEditable:true}),
 d({key:'lump.share',area:'lump',unit:'percent',appliesTo:'all',value:10000,type:'note',valueEditable:true,typeEditable:false,min:0,max:10000}),
 d({key:'lump.step',area:'lump',unit:'myr',appliesTo:'all',value:5000,type:'note',valueEditable:true,typeEditable:false,min:1000,max:100_000_000}),
 d({key:'lump.cap',area:'lump',unit:'myr',appliesTo:'all',value:null,type:'note',valueEditable:true,typeEditable:false,nullable:true,min:0,max:100_000_000_000}),
 d({key:'lump.aboveSuggestion',area:'lump',unit:'none',appliesTo:'all',value:null,type:'warning',valueEditable:false,typeEditable:true}),
 d({key:'lump.individualAmendment',area:'lump',unit:'none',appliesTo:'all',value:null,type:'exception',valueEditable:false,typeEditable:true}),
 d({key:'exemption.budgetCapsOnly',area:'exemption',unit:'none',appliesTo:'all',value:null,type:'note',fixed:true,valueEditable:false,typeEditable:false}),
 d({key:'advisor.override',area:'advisor',unit:'points',appliesTo:'all',value:200,type:'note',valueEditable:true,typeEditable:false,min:0,max:10000}),
 d({key:'advisor.longWithoutIncrease',area:'advisor',unit:'years',appliesTo:'all',value:3,type:'note',valueEditable:true,typeEditable:false,min:1,max:20}),
 d({key:'advisor.peerGap',area:'advisor',unit:'percent',appliesTo:'all',value:1500,type:'note',valueEditable:true,typeEditable:false,min:0,max:10000}),
] as const satisfies readonly Definition[];
export type RewardLimitKey=typeof rewardLimitDefinitions[number]['key'];
export const rewardLimitKeys=rewardLimitDefinitions.map(row=>row.key) as RewardLimitKey[];
export const rewardLimitDefinition=(key:RewardLimitKey):Definition=>rewardLimitDefinitions.find(row=>row.key===key)!;
/** The keys a version may carry: every row that is not a fixed invariant. */
export const rewardConfigurableLimitKeys=rewardLimitDefinitions.filter(row=>!('fixed' in row&&row.fixed)).map(row=>row.key) as RewardLimitKey[];

export type RewardLimitSetting={value:number|null;type:RewardLimitType};
export type RewardLimitValues=Record<RewardLimitKey,RewardLimitSetting>;
export const baselineRewardLimitValues=():RewardLimitValues=>Object.fromEntries(rewardLimitDefinitions.map(row=>[row.key,{value:row.value,type:row.type}])) as RewardLimitValues;

/** A stored version's values: exactly the configurable keys, each within its bounds, with a fixed type where the
 * type cannot change. Fixed invariants are never accepted. */
export const rewardLimitValuesSchema=z.record(z.string(),z.object({value:z.number().int().nullable(),type:z.enum(rewardLimitTypes)}).strict()).superRefine((raw,ctx)=>{
 const keys=Object.keys(raw);
 for(const key of keys)if(!rewardConfigurableLimitKeys.includes(key as RewardLimitKey))ctx.addIssue({code:'custom',path:[key],message:'This limit is fixed and cannot be changed.'});
 for(const key of rewardConfigurableLimitKeys){
  const row=rewardLimitDefinition(key),setting=raw[key];
  if(!setting){ctx.addIssue({code:'custom',path:[key],message:'Every limit needs a value and a type.'});continue;}
  if(!row.typeEditable&&setting.type!==row.type)ctx.addIssue({code:'custom',path:[key,'type'],message:'This limit is a calculation setting; its type cannot change.'});
  if(!row.valueEditable){if(setting.value!==null)ctx.addIssue({code:'custom',path:[key,'value'],message:'This check has no value.'});continue;}
  if(setting.value===null){if(!row.nullable)ctx.addIssue({code:'custom',path:[key,'value'],message:'Enter a value.'});continue;}
  if(row.min!==undefined&&setting.value<row.min||row.max!==undefined&&setting.value>row.max)ctx.addIssue({code:'custom',path:[key,'value'],message:'The value is outside the allowed range.'});
  if(key==='lump.step'&&setting.value%1000!==0)ctx.addIssue({code:'custom',path:[key,'value'],message:'Rounding must be in RM 10 steps.'});
 }
}).transform(raw=>Object.fromEntries(rewardConfigurableLimitKeys.map(key=>[key,raw[key]])) as Partial<RewardLimitValues>);
export type RewardLimitVersionValues=z.output<typeof rewardLimitValuesSchema>;

/** The confirmed limits a calculation uses. `baseline` is the behaviour before Limit Controls: the engine constants,
 * with pools and lump-sum settings taken from the review's own policy, so a review with no version keeps its
 * amounts and checks exactly. `version` is a saved Limit Controls version for the reward year. */
export type RewardLimits={source:'baseline'|'version';versionId:string|null;revision:number|null;year:number|null;values:RewardLimitValues};
export const baselineRewardLimits=(policy?:Pick<RewardPolicy,'standardPools'|'hPools'|'lumpShareBp'|'lumpStepCents'|'lumpCapCents'>|null):RewardLimits=>{
 const values=baselineRewardLimitValues();
 if(policy){
  (['merit','promotion','special'] as const).forEach((pool,i)=>{values[`pool.standard.${pool}`]={...values[`pool.standard.${pool}`],value:policy.standardPools[i]};values[`pool.h.${pool}`]={...values[`pool.h.${pool}`],value:policy.hPools[i]};});
  values['lump.share']={...values['lump.share'],value:policy.lumpShareBp};values['lump.step']={...values['lump.step'],value:policy.lumpStepCents};values['lump.cap']={...values['lump.cap'],value:policy.lumpCapCents};
 }
 return{source:'baseline',versionId:null,revision:null,year:null,values};
};
/** A stored version over the baseline: configurable keys from the version, fixed invariants always from the baseline. */
export function versionRewardLimits(version:{id:string;revision:number;year:number;values:unknown}):RewardLimits{
 const stored=rewardLimitValuesSchema.parse(version.values),values=baselineRewardLimitValues();
 for(const key of rewardConfigurableLimitKeys)if(stored[key])values[key]=stored[key]!;
 return{source:'version',versionId:version.id,revision:version.revision,year:version.year,values};
}
/** The limit a value-bearing key resolves to (callers treat a null cap as "no cap"). */
export const limitValue=(limits:RewardLimits,key:RewardLimitKey)=>limits.values[key].value;
export const limitNumber=(limits:RewardLimits,key:RewardLimitKey)=>{const value=limits.values[key].value;if(value===null)throw new Error(`Limit ${key} has no value.`);return value;};
/** Engine severity for a limit type. A Note travels as an information item. */
export const limitSeverity=(limits:RewardLimits,key:RewardLimitKey):RewardFlag['severity']=>{const type=limits.values[key].type;return type==='note'?'review':type;};

/** Plain-language flag text: what to fix and whether it stops submission. It never states the limit's value. */
export function limitFlagText(subject:string,severity:RewardFlag['severity'],fix:string){
 if(severity==='block')return `${subject} – ${fix} to submit.`;
 if(severity==='exception'||severity==='warning')return `${subject} – give a reason before you submit.`;
 return `${subject}.`;
}

/** Display text for a value in the change summary and the change log. */
export function rewardLimitDisplay(key:RewardLimitKey,value:number|null):string{
 const row=rewardLimitDefinition(key);
 if(row.unit==='none')return '—';
 if(value===null)return 'None';
 switch(row.unit){
  case 'percent':return `${(value/100).toFixed(2).replace(/\.?0+$/,'')}%`;
  case 'points':return `±${(value/100).toFixed(2).replace(/\.?0+$/,'')} pp`;
  case 'ratio':return (value/10000).toFixed(2);
  case 'months':return `${(value/10000).toFixed(2)} months`;
  case 'myr':return `RM ${(value/100).toFixed(2)}`;
  case 'grade':return `JG ${value}`;
  case 'grades':return `${value} grades`;
  case 'years':return `${value} years`;
 }
}
const typeLabel:Record<RewardLimitType,string>={block:'Block',exception:'Exception',warning:'Warning',note:'Note'};
/** Flat display records for rewardConfigLines: one value and one type per configurable key. */
export function rewardLimitSummaryRecord(values:RewardLimitValues|null):Record<string,string|null>|null{
 if(!values)return null;
 return Object.fromEntries(rewardConfigurableLimitKeys.flatMap(key=>{
  const row=rewardLimitDefinition(key),out:[string,string|null][]=[];
  if(row.valueEditable)out.push([`${key}:value`,rewardLimitDisplay(key,values[key].value)]);
  if(row.typeEditable)out.push([`${key}:type`,typeLabel[values[key].type]]);
  return out;
 }));
}

/** Who may see Limit Controls. Group Rewards edits; CTRO and EC view; every other role sees only plain-language
 * checks. The server enforces this through app.reward_limit_controls_access(); this mirror is for the Rewards
 * Access permission grid (board db14e49c). */
export type RewardLimitAccess='edit'|'view'|null;
export function rewardLimitAccessForRole(role:string):RewardLimitAccess{
 return role==='gr'?'edit':role==='ctro'||role==='ec'?'view':null;
}
/** Applied rule references whose explanation states a limit value. Readers without Limit Controls access get the
 * plain explanation without values, controls or references. */
export const rewardLimitRuleRefs=['POOL-01','PRO-01','POOL-04','POOL-10','SAL-02','SAL-03','BUD-01','BUD-03','BUD-05'] as const;

/** Reviews a limit change reaches, from one bounded set-wise read. */
export type RewardLimitReviewStage={reviewId:string;label:string;stage:string;released:boolean;pinnedRevision:number|null;pinned:boolean};
/** Draft reviews follow the current version; reviews past Draft keep theirs. */
export const rewardLimitReapplicableStages=['bg','gr','ctro','ec'] as const;

/** English labels for the change summary and the change log (pages use the i18n catalogue). */
export const rewardLimitLabels:Record<RewardLimitKey,string>={
 'pool.standard.merit':'Merit pool (Standard plan)','pool.standard.promotion':'Promotion pool (Standard plan)','pool.standard.special':'Special adjustment pool (Standard plan)',
 'pool.h.merit':'Merit pool (JG H plan)','pool.h.promotion':'Promotion pool (JG H plan)','pool.h.special':'Special adjustment pool (JG H plan)',
 'pool.separate':'Pools cannot fund each other or another company',
 'increase.withoutPromotion':'Total increase without promotion','increase.withPromotion':'Total increase with promotion','promotion.increment':'Promotion increment',
 'promotion.maxGrades':'Maximum grades up','promotion.maxGrade':'Highest grade after promotion','catchUp.crFloor':'CR catch-up floor (STAR/SSTAR)','salary.noReduction':'No salary reduction',
 'bonus.poolCap':'Bonus pool cap','bonus.underUse':'Bonus under-use warning','bonus.individualCeiling':'Individual bonus ceiling','bonus.rounding':'Bonus payout rounding (round down)',
 'bonus.individualMultiplier':'Individual multiplier different from the unit',
 'lump.share':'Lump sum share of remaining balance','lump.step':'Lump sum rounding step','lump.cap':'Lump sum per-person cap','lump.aboveSuggestion':'Lump sum above the suggestion','lump.individualAmendment':'Individual lump sum amendments',
 'exemption.budgetCapsOnly':'Exemptions apply to budget caps only',
 'advisor.override':'AI advisor override threshold','advisor.longWithoutIncrease':'AI advisor: long time without increase','advisor.peerGap':'AI advisor: peer pay gap',
};
export const rewardLimitLineLabel=(lineKey:string)=>{const [key,part]=lineKey.split(':') as [RewardLimitKey,string];return `${rewardLimitLabels[key]??key} · ${part==='type'?'Type':'Value'}`;};
