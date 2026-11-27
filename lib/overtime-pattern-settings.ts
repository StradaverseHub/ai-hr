/** Board 4197534a — Overtime Settings: the Schedule Group > Overtime hour-range table (From, To, OT Rate, PH Rate,
 * Rounding, Round To) plus a rest/off day rate, the hourly basis and the payroll item, projected onto the canonical
 * formula definition the evaluator already runs.
 *
 * Owner decision recorded by the approved plan (ADR-0123 amendment, 4197534a): overtime is counted once per working
 * day (eligibilityBasis 'day'), counts are allocated earliest-first ('earliest'), and no time-of-day bands are
 * offered, so the allocation cannot change an amount. The hourly rate is the recorded calculation base (basic salary
 * plus fixed monthly allowance) divided by the monthly hours HR enters; the system never picks that number.
 *
 * Mapping (three rates, one per kind of day, all with the same rows):
 *   ot_normal   when dayType in [workday]            multiplier = OT Rate
 *   ot_rest     when dayType in [off_day, rest_day]  multiplier = rest/off day rate, or OT Rate when blank
 *   ot_holiday  when dayType in [holiday]            multiplier = PH Rate, or OT Rate when blank
 * Each row is a marginal tier from..to (minutes), with its own rounding, paid hourly at
 * calculationBase / (monthly hours x 60 minutes) x multiplier, mapped to one earning item.
 *
 * A saved definition that does not fit this table (formula or flat payments, time bands, pattern-level rounding,
 * deductions, caps, other rates) projects to null: the editor shows it read-only and never rewrites it.
 * Pure and client-safe. It never calculates money. */
import type {OvertimeCondition,OvertimeExpression,OvertimePattern,OvertimeRate,OvertimeTier} from './overtime-pattern-model';
import {overtimeClockInput,overtimeClockToMinutes} from './overtime-pattern-guided';
import {OVERTIME_STARTERS} from './overtime-pattern-starters';

export type OvertimeSettingsRounding='none'|'down'|'up';
/** Clock text as typed (h:mm); blank To = no limit; blank rest/PH rate = the OT Rate. */
export type OvertimeSettingsRow={from:string;to:string;rate:string;restRate:string;phRate:string;rounding:OvertimeSettingsRounding;roundTo:string};
export type OvertimeSettings={rows:OvertimeSettingsRow[];monthlyHours:string;earningItemId:string};

export const OVERTIME_SETTINGS_RATES=[
 {id:'ot_normal',days:['workday'],column:'rate'},
 {id:'ot_rest',days:['off_day','rest_day'],column:'restRate'},
 {id:'ot_holiday',days:['holiday'],column:'phRate'},
] as const;
export const OVERTIME_SETTINGS_ROUNDING:readonly OvertimeSettingsRounding[]=['none','down','up'];

export function blankOvertimeSettingsRow(from=''):OvertimeSettingsRow {return {from,to:'',rate:'',restRate:'',phRate:'',rounding:'none',roundTo:''};}
export function blankOvertimeSettings():OvertimeSettings {return {rows:[blankOvertimeSettingsRow('0:00')],monthlyHours:'',earningItemId:''};}

/** Monthly hours (up to 2 decimals) <-> divisor minutes, exactly. Anything else is kept as typed so draft validation
 * keeps it visible and activation refuses it. */
export function overtimeHoursToMinutes(hours:string):string {
 const text=hours.trim();
 const match=/^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(text);
 if(!match)return text;
 const hundredths=BigInt(match[1])*BigInt(100)+BigInt((match[2]??'').padEnd(2,'0'));
 const scaled=hundredths*BigInt(60);
 return decimalFromHundredths(scaled);
}
export function overtimeMinutesToHours(minutes:string):string {
 const match=/^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(minutes);
 if(!match)return minutes;
 const hundredths=BigInt(match[1])*BigInt(100)+BigInt((match[2]??'').padEnd(2,'0'));
 if(hundredths%BigInt(60)!==BigInt(0))return minutes;
 return decimalFromHundredths(hundredths/BigInt(60));
}
function decimalFromHundredths(value:bigint):string {
 const whole=value/BigInt(100),fraction=String(value%BigInt(100)).padStart(2,'0').replace(/0+$/,'');
 return fraction?`${whole}.${fraction}`:String(whole);
}

const dayCondition=(id:string,days:readonly string[]):OvertimeCondition=>({id:id+'_days',type:'group',logic:'and',children:[{id:id+'_day_type',type:'selection',field:'dayType',operator:'in',values:[...days]}]});
/** Every node id in a definition is unique, so each tier's expressions carry the tier id. */
function hourlyRate(tierId:string,divisorMinutes:string):OvertimeExpression {
 return {id:tierId+'_rate',unit:'moneyPerHour',type:'hourlyRate',base:{id:tierId+'_base',unit:'money',type:'field',field:'calculationBase'},divisorMinutes:{id:tierId+'_divisor',unit:'minutes',type:'literal',value:divisorMinutes}};
}

/** Replace only the rates of `base` with the table; currency, eligibility (day types) and the owner-decided duration
 * policies are kept or set as the owner decided. */
export function overtimeSettingsToDefinition(base:OvertimePattern,settings:OvertimeSettings):OvertimePattern {
 const divisor=overtimeHoursToMinutes(settings.monthlyHours);
 const currency=base.currency.code;
 const rates:OvertimeRate[]=OVERTIME_SETTINGS_RATES.map((rate,index)=>({
  id:rate.id,name:rate.id,description:'',priority:index,when:dayCondition(rate.id,rate.days),timeBand:null,accumulation:'day',tierMode:'marginal',
  tiers:settings.rows.map((row,i):OvertimeTier=>{
   const multiplier=(rate.column==='rate'?row.rate:row[rate.column].trim()||row.rate).trim();
   const tierId=`${rate.id}_${i}`;
   return {id:tierId,from:overtimeClockToMinutes(row.from.trim()),to:row.to.trim()===''?null:overtimeClockToMinutes(row.to.trim()),
    payment:{method:'hourly',rate:hourlyRate(tierId,divisor),multiplier:{id:tierId+'_multiplier',unit:'scalar',type:'literal',value:multiplier}},
    mapping:{earningItemId:settings.earningItemId,currency},
    ...(row.rounding==='none'?{}:{rounding:{step:overtimeClockToMinutes(row.roundTo.trim()),mode:row.rounding}})};
  }),
 }));
 return {...base,eligibilityBasis:'day',durationAllocation:'earliest',definitions:[],eligibleMinutes:null,durationCap:null,durationRounding:null,deductions:[],paymentCap:null,rates};
}

function literal(expression:OvertimeExpression,unit:OvertimeExpression['unit']):string|null {return expression.type==='literal'&&expression.unit===unit&&!expression.currency?expression.value:null;}
function divisorOf(tier:OvertimeTier):string|null {
 const payment=tier.payment;
 if(payment.method!=='hourly'||payment.rate.type!=='hourlyRate'||payment.rate.unit!=='moneyPerHour')return null;
 const {base,divisorMinutes}=payment.rate;
 if(base.type!=='field'||base.field!=='calculationBase'||base.unit!=='money')return null;
 return literal(divisorMinutes,'minutes');
}
function daysOf(condition:OvertimeCondition):string[]|null {
 if(condition.type==='group'&&condition.logic==='and'&&condition.children.length===1)return daysOf(condition.children[0]);
 if(condition.type==='selection'&&condition.field==='dayType'&&condition.operator==='in')return [...condition.values].sort();
 return null;
}
const allDays=(condition:OvertimeCondition)=>condition.type==='group'&&condition.logic==='and'&&condition.children.length===0||condition.type==='constant'&&condition.value;

/** The table a definition expresses, or null when it does not fit (shown read-only and kept byte-for-byte). A blank
 * definition and an unchanged starting template project to an editable table. */
export function definitionToOvertimeSettings(pattern:OvertimePattern):OvertimeSettings|null {
 if(pattern.definitions.length||pattern.eligibleMinutes||pattern.durationCap||pattern.durationRounding||pattern.deductions.length||pattern.paymentCap)return null;
 if(!pattern.rates.length)return blankOvertimeSettings();
 const tiersFit=(rate:OvertimeRate)=>rate.timeBand===null&&rate.accumulation==='day'&&rate.tierMode==='marginal'&&rate.tiers.length>0;
 // A starting template: one rate for every day, one open tier.
 if(pattern.rates.length===1&&OVERTIME_STARTERS.some(starter=>starter.name===pattern.rates[0].name)){
  const rate=pattern.rates[0],tier=rate.tiers[0];
  if(!tiersFit(rate)||!allDays(rate.when)||rate.tiers.length!==1||tier.to!==null||tier.rounding||tier.payment.method!=='hourly')return null;
  const divisor=divisorOf(tier),multiplier=literal(tier.payment.multiplier,'scalar');
  if(divisor===null||multiplier===null)return null;
  return {rows:[{...blankOvertimeSettingsRow(overtimeClockInput(tier.from)),rate:multiplier}],monthlyHours:overtimeMinutesToHours(divisor),earningItemId:tier.mapping.earningItemId};
 }
 if(pattern.rates.length!==OVERTIME_SETTINGS_RATES.length)return null;
 const byId=new Map(pattern.rates.map(rate=>[rate.id,rate]));
 const rates=OVERTIME_SETTINGS_RATES.map(item=>byId.get(item.id));
 if(rates.some(rate=>!rate||!tiersFit(rate)))return null;
 const [normal,rest,holiday]=rates as OvertimeRate[];
 if(OVERTIME_SETTINGS_RATES.some((item,i)=>JSON.stringify(daysOf(rates[i]!.when))!==JSON.stringify([...item.days].sort())))return null;
 const count=normal.tiers.length;
 if(rest.tiers.length!==count||holiday.tiers.length!==count)return null;
 let divisor:string|null=null,earningItemId:string|null=null;
 const rows:OvertimeSettingsRow[]=[];
 for(let i=0;i<count;i++){
  const tiers=[normal.tiers[i],rest.tiers[i],holiday.tiers[i]];
  for(const tier of tiers){
   const own=divisorOf(tier);
   if(own===null||divisor!==null&&own!==divisor)return null;
   divisor=own;
   if(earningItemId!==null&&tier.mapping.earningItemId!==earningItemId)return null;
   earningItemId=tier.mapping.earningItemId;
   if(tier.from!==tiers[0].from||tier.to!==tiers[0].to||JSON.stringify(tier.rounding??null)!==JSON.stringify(tiers[0].rounding??null))return null;
  }
  const rounding=tiers[0].rounding;
  if(rounding&&rounding.mode!=='down'&&rounding.mode!=='up')return null;
  const [rate,restRate,phRate]=tiers.map(tier=>tier.payment.method==='hourly'?literal(tier.payment.multiplier,'scalar'):null);
  if(rate===null||restRate===null||phRate===null)return null;
  rows.push({from:overtimeClockInput(tiers[0].from),to:tiers[0].to===null?'':overtimeClockInput(tiers[0].to),rate,
   restRate:restRate===rate?'':restRate,phRate:phRate===rate?'':phRate,
   rounding:rounding?rounding.mode as OvertimeSettingsRounding:'none',roundTo:rounding?overtimeClockInput(rounding.step):''});
 }
 return {rows,monthlyHours:overtimeMinutesToHours(divisor??''),earningItemId:earningItemId??''};
}

/** Editor-side checks shown next to the table (the activation validator remains the authority). */
export type OvertimeSettingsProblem='rowsRequired'|'firstFrom'|'gap'|'openEnded'|'rate'|'roundTo'|'monthlyHours'|'earningItem';
export function overtimeSettingsProblems(settings:OvertimeSettings):OvertimeSettingsProblem[] {
 const problems=new Set<OvertimeSettingsProblem>();
 const minutes=(clock:string)=>{const value=overtimeClockToMinutes(clock.trim());return /^\d+(\.\d+)?$/.test(value)?Number(value):null;};
 const rate=(text:string)=>/^\d{1,2}(\.\d{1,2})?$/.test(text.trim());
 if(!settings.rows.length)problems.add('rowsRequired');
 settings.rows.forEach((row,i)=>{
  const from=minutes(row.from),to=row.to.trim()===''?null:minutes(row.to);
  if(i===0&&from!==0)problems.add('firstFrom');
  if(i>0){const previous=settings.rows[i-1];if(previous.to.trim()===''||minutes(previous.to)!==from)problems.add('gap');}
  if(to!==null&&from!==null&&to<=from||row.to.trim()!==''&&to===null)problems.add('gap');
  if(!rate(row.rate)||row.restRate.trim()&&!rate(row.restRate)||row.phRate.trim()&&!rate(row.phRate))problems.add('rate');
  if(row.rounding!=='none'&&(minutes(row.roundTo)??0)<=0)problems.add('roundTo');
 });
 if(settings.rows.length&&settings.rows.at(-1)!.to.trim()!=='')problems.add('openEnded');
 if(!/^\d{1,4}(\.\d{1,2})?$/.test(settings.monthlyHours.trim())||Number(settings.monthlyHours)<=0)problems.add('monthlyHours');
 if(!settings.earningItemId)problems.add('earningItem');
 return [...problems];
}

/** Structural check of a posted table (strings within bounds, at most 64 rows). Values stay as typed: the draft
 * validator keeps them, and activation refuses what is not a valid number. */
export function parseOvertimeSettings(raw:unknown):OvertimeSettings {
 const invalid=():never=>{throw new RangeError('Invalid overtime settings');};
 if(!raw||typeof raw!=='object'||Array.isArray(raw))invalid();
 const r=raw as Record<string,unknown>;
 const str=(value:unknown,max=32)=>{if(typeof value!=='string'||value.length>max)invalid();return value as string;};
 if(!Array.isArray(r.rows)||r.rows.length>64)invalid();
 const rows=(r.rows as unknown[]).map(item=>{
  if(!item||typeof item!=='object')invalid();
  const row=item as Record<string,unknown>;
  if(!OVERTIME_SETTINGS_ROUNDING.includes(row.rounding as OvertimeSettingsRounding))invalid();
  return {from:str(row.from),to:str(row.to),rate:str(row.rate),restRate:str(row.restRate),phRate:str(row.phRate),rounding:row.rounding as OvertimeSettingsRounding,roundTo:str(row.roundTo)};
 });
 const earningItemId=str(r.earningItemId,64);
 if(earningItemId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(earningItemId))invalid();
 return {rows,monthlyHours:str(r.monthlyHours),earningItemId};
}
