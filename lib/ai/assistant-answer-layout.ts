/** Layout only: the caller must first assertCanonicalModuleJobView for every current view.
 * These references grant no authority and the result carries no copied facts, titles or URLs.
 */
import {JOB_FACT_FIELDS,type JobFact,type JobFactField,type JobPresentation} from './module-jobs';
export type ConversationFactReference=Readonly<{sourceKey:string;presentation:JobPresentation;card:number;fact:number}>;
export type ConversationFactLayout=Readonly<{kind:'list'}>|Readonly<{kind:'comparison';columns:readonly Readonly<{field:JobFactField;format:JobFact['format']}>[];rows:readonly Readonly<{sourceKey:string;card:number;positions:readonly number[]}>[]}>;
const LIST=Object.freeze({kind:'list'} as const);
const FIELDS=new Set<string>(JOB_FACT_FIELDS);
const FORMATS=new Set(['text','number','date','status','boolean','money','module','gap','blocks','performanceFramework','performanceArtifact','testingStatus']);
function cell(fact:JobFact):boolean{
 if(!fact||!FIELDS.has(fact.field)||!FORMATS.has(fact.format)||fact.value===null)return false;
 const value=fact.value;
 if(typeof value==='number')return Number.isFinite(value)&&fact.format!=='boolean';
 if(typeof value==='boolean')return fact.format==='boolean';
 if(typeof value!=='string'||value.trim()===''||value.length>500)return false;
 if(fact.format==='boolean')return false;
 if(fact.format==='number'||fact.format==='money')return /^-?\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value));
 return true;
}
function unit(facts:readonly JobFact[],field:'currency'|'creditUnit'|'rewardUnit'):string|null|false{
 const found=facts.filter(fact=>fact.field===field);
 if(found.length===0)return null;
 if(found.length!==1||!cell(found[0])||typeof found[0].value!=='string')return false;
 return field==='currency'&&!/^[A-Z]{3}$/.test(found[0].value)?false:found[0].value;
}
/** Preserve selected order. Incomparable references remain a list, never a partial table. */
export function conversationFactLayout(refs:readonly ConversationFactReference[]):ConversationFactLayout{
 if(!Array.isArray(refs)||refs.length<2||refs.length>48)return LIST;
 const first=refs[0];if(!first||typeof first.sourceKey!=='string'||first.sourceKey.trim()===''||first.sourceKey.length>200||!first.presentation||!Array.isArray(first.presentation.cards))return LIST;
 const groups:{sourceKey:string;card:number;positions:number[];facts:JobFact[]}[]=[],seen=new Set<number>();
 for(let position=0;position<refs.length;position++){
  const ref=refs[position];if(!ref||Object.keys(ref).sort().join(',')!=='card,fact,presentation,sourceKey'||ref.sourceKey!==first.sourceKey||ref.presentation!==first.presentation||!Number.isSafeInteger(ref.card)||ref.card<0||ref.card>=ref.presentation.cards.length||!Number.isSafeInteger(ref.fact)||ref.fact<0)return LIST;
  const card=ref.presentation.cards[ref.card];if(!card||card.withheld===true||!Array.isArray(card.facts)||ref.fact>=card.facts.length||!cell(card.facts[ref.fact]))return LIST;
  let group=groups.at(-1);
  if(!group||group.card!==ref.card){if(seen.has(ref.card)||groups.length===8)return LIST;seen.add(ref.card);group={sourceKey:ref.sourceKey,card:ref.card,positions:[],facts:[]};groups.push(group);}
  if(group.facts.length===6||group.facts.some(fact=>fact.field===card.facts[ref.fact].field))return LIST;
  group.positions.push(position);group.facts.push(card.facts[ref.fact]);
 }
 if(groups.length<2)return LIST;
 const columns=groups[0].facts.map(fact=>Object.freeze({field:fact.field,format:fact.format}));
 const numeric=columns.some(column=>column.format==='money'||column.format==='number'),money=columns.some(column=>column.format==='money');
 const unitFields:('currency'|'creditUnit'|'rewardUnit')[]=[...(money?['currency' as const]:[]),...(numeric?['creditUnit' as const,'rewardUnit' as const]:[])];
 const units=unitFields.map(field=>unit(first.presentation.cards[groups[0].card].facts,field));
 if(units.some((value,index)=>value===false||unitFields[index]==='currency'&&value===null))return LIST;
 for(const group of groups){
  if(group.facts.length!==columns.length||group.facts.some((fact,index)=>fact.field!==columns[index].field||fact.format!==columns[index].format))return LIST;
  if(unitFields.some((field,index)=>unit(first.presentation.cards[group.card].facts,field)!==units[index]))return LIST;
 }
 return Object.freeze({kind:'comparison',columns:Object.freeze(columns),rows:Object.freeze(groups.map(group=>Object.freeze({sourceKey:group.sourceKey,card:group.card,positions:Object.freeze([...group.positions])})))});
}
