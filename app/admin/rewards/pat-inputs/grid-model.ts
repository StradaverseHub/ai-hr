/** Board 2103041d: pure PAT grid parsing and row state, shared by the grid and its tests. Integer cents and basis
 * points only; pools are never computed here. */
import type {PatInput} from '@/packs/rewards/setup-model';
export const FIELDS=['targetCents','forecastCents','actualCents','targetMonthsBp'] as const;
export type FieldKey=typeof FIELDS[number];
export const LABEL:Record<FieldKey,string>={targetCents:'target',forecastCents:'forecast',actualCents:'actual',targetMonthsBp:'months'};
export const DEFAULT:PatInput={targetCents:null,forecastCents:null,actualCents:null,targetMonthsBp:20000};
const scale=(key:FieldKey)=>key==='targetMonthsBp'?10000:100;
export const formatPatValue=(key:FieldKey,value:number|null)=>value===null?'':(value/scale(key)).toFixed(2);
/** Text to integer units: two decimals at most, negative only for forecast and actual (a reported loss). */
export function parsePatValue(key:FieldKey,raw:string):number|null|'invalid'{
 const text=raw.trim().replace(/,/g,'');if(!text)return key==='targetMonthsBp'?'invalid':null;
 const pattern=key==='forecastCents'||key==='actualCents'?/^-?\d{1,10}(?:\.\d{1,2})?$/:/^\d{1,10}(?:\.\d{1,2})?$/;
 if(!pattern.test(text))return 'invalid';
 const sign=text.startsWith('-')?-1:1,[whole,fraction='']=text.replace(/^-/,'').split('.');
 const cents=sign*(Number(whole)*100+Number(fraction.padEnd(2,'0')));
 return key==='targetMonthsBp'?cents*100:cents;
}
/** One row's figures and the problems the service would refuse, so the grid can mark them before saving. */
export function patRowState(base:PatInput,edits:Partial<Record<FieldKey,string>>|undefined){
 const values={...base},invalid=new Set<FieldKey>();
 for(const key of FIELDS){const raw=edits?.[key];if(raw===undefined)continue;const parsed=parsePatValue(key,raw);if(parsed==='invalid')invalid.add(key);else if(key==='targetMonthsBp'){if(parsed!==null)values.targetMonthsBp=parsed;}else values[key]=parsed;}
 if(values.targetCents!==null&&values.targetCents<=0)invalid.add('targetCents');
 if(values.targetCents===null&&(values.actualCents!==null||values.forecastCents!==null))invalid.add('targetCents');
 if(values.targetMonthsBp>100_000||values.targetMonthsBp%100!==0)invalid.add('targetMonthsBp');
 const changed=FIELDS.filter(key=>edits?.[key]!==undefined&&!invalid.has(key)&&values[key]!==base[key]);
 const numerator=values.actualCents??values.forecastCents;
 const status:'not-set'|'provisional'|'final'=values.targetCents===null||numerator===null?'not-set':values.actualCents!==null?'final':'provisional';
 const achievementBp=status==='not-set'||!values.targetCents?null:Math.trunc(numerator!*10000/values.targetCents);
 return{values,invalid,changed,status,achievementBp,missing:{target:values.targetCents===null,actual:values.actualCents===null}};
}
