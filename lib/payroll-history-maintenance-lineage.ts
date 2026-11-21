import {PayrollHistoryRevisionError} from './payroll-history-revisions';
/** Immutable contribution chains carried by the existing import revision owner, never a money ledger. */
import type {PayrollImportDestination} from './payroll-history-import-schema';
export type HistoryOwnedItem={key:string;code:string;label:string;originalCodes:string[];amount:string;destination:PayrollImportDestination;direction:'earning'|'deduction'|'noncash'|'statutory';sourceRows:number[]};
export type HistoryContribution={attemptId:string|null;item:HistoryOwnedItem|null};
export type HistoryContributionState={version:1;baselineSnapshotId:string|null;chains:Record<string,HistoryContribution[]>};
function fail(message:string):never{throw new PayrollHistoryRevisionError(message);}
export function historyMoneyCents(value:string):bigint{if(!/^\d+(?:\.\d{1,2})?$/.test(value))fail('Enter a non-negative amount with at most two decimal places.');const [whole,fraction='']=value.split('.');const cents=BigInt(whole+fraction.padEnd(2,'0'));if(cents>BigInt(999999999999))fail('The item amount exceeds the supported payroll range.');return cents;}
export const historyMoney=(cents:bigint)=>`${cents/BigInt(100)}.${String(cents%BigInt(100)).padStart(2,'0')}`;
export function aggregateHistoryItems(items:readonly HistoryOwnedItem[]):HistoryOwnedItem[]{const out=new Map<string,HistoryOwnedItem>();for(const item of items){const prior=out.get(item.key);if(prior&&(prior.code!==item.code||prior.destination!==item.destination||prior.direction!==item.direction))fail('A canonical Pay Item has ambiguous source mappings.');const amount=historyMoneyCents(item.amount)+(prior?historyMoneyCents(prior.amount):BigInt(0));if(amount>BigInt(999999999999))fail('The accumulated item total exceeds the supported payroll range.');out.set(item.key,{...item,amount:historyMoney(amount),originalCodes:[...new Set([...(prior?.originalCodes??[]),...item.originalCodes])].sort(),sourceRows:[...new Set([...(prior?.sourceRows??[]),...item.sourceRows])].sort((a,b)=>a-b)});}return [...out.values()].sort((a,b)=>a.key.localeCompare(b.key));}
export function effectiveHistoryItems(state:HistoryContributionState):HistoryOwnedItem[]{return Object.entries(state.chains).flatMap(([key,entries])=>{const item=entries[0]?.item;if(item&&item.key!==key)fail('The retained item identity is inconsistent.');return item?[structuredClone(item)]:[];}).sort((a,b)=>a.key.localeCompare(b.key));}
export function appendHistoryContribution(prior:HistoryContributionState,attemptId:string,items:readonly HistoryOwnedItem[],mode:'replace'|'update_listed'):HistoryContributionState{
 const state=structuredClone(prior),incoming=new Map(aggregateHistoryItems(items).map(item=>[item.key,item]));
 const keys=mode==='replace'?new Set([...Object.keys(state.chains),...incoming.keys()]):new Set(incoming.keys());
 for(const key of keys){const item=incoming.get(key)??null;state.chains[key]=[{attemptId,item},...(state.chains[key]??[])];}
 return state;
}
export function removeHistoryItems(prior:HistoryContributionState,attemptId:string,keys:readonly string[]):HistoryContributionState{const state=structuredClone(prior);for(const key of new Set(keys)){if(!state.chains[key]?.[0]?.item)fail('A selected item is no longer effective. Refresh the history record.');state.chains[key]=[{attemptId,item:null},...state.chains[key]];}return state;}
/** Remove this attempt at EVERY depth so another later removal cannot resurrect its obsolete contribution. */
export function removeHistoryAttempt(prior:HistoryContributionState,attemptId:string):HistoryContributionState{const state=structuredClone(prior);for(const key of Object.keys(state.chains)){state.chains[key]=state.chains[key].filter(entry=>entry.attemptId!==attemptId);if(!state.chains[key].length)delete state.chains[key];}return state;}
export function historyContributionChanges(before:HistoryContributionState,after:HistoryContributionState,removedAttempt?:string){const old=new Map(effectiveHistoryItems(before).map(item=>[item.key,item])),now=new Map(effectiveHistoryItems(after).map(item=>[item.key,item]));return [...new Set([...old.keys(),...now.keys()])].sort().map(key=>{const a=old.get(key),b=now.get(key),item=b??a!;return{key,code:item.code,label:item.label,before:a?.amount??null,after:b?.amount??null,operation:!a?'add' as const:!b?'remove' as const:a.amount===b.amount?'keep' as const:removedAttempt?'restore' as const:'change' as const,...(removedAttempt&&before.chains[key]?.[0]?.attemptId!==removedAttempt?{laterCorrection:true}:{})};});}

export function retainedNativeHistoryBaseline(prior:HistoryContributionState):HistoryContributionState{return{version:1,baselineSnapshotId:prior.baselineSnapshotId,chains:Object.fromEntries(Object.entries(prior.chains).flatMap(([key,entries])=>{const native=entries.find(entry=>entry.attemptId===null&&entry.item!==null);return native?[[key,[structuredClone(native)]]]:[];}))};}

/** Verify retained line ownership against original stored totals; never reclassify an unlisted cash line. */
export function historyItemsMatchValues(items:readonly HistoryOwnedItem[],values:import('./payroll-history-revisions').ImportedPayrollValues):boolean{
 const total=(destination:string)=>items.filter(item=>item.destination===destination).reduce((sum,item)=>sum+historyMoneyCents(item.amount),BigInt(0));
 for(const [destination,property]of [['basic','basicSalary'],['allowance','allowance'],['overtime','overtimePay'],['bonus','bonus'],['other_deduction','otherDeductions']] as const)if(total(destination)!==historyMoneyCents(values[property]))return false;
 const statutory:Record<string,string>={epf_employee:'epfEmployee',epf_employer:'epfEmployer',socso_employee:'socsoEmployee',socso_employer:'socsoEmployer',socso_skbbk:'socsoSkbbk',eis_employee:'eisEmployee',eis_employer:'eisEmployer',pcb:'pcb',cp38:'cp38',zakat:'zakat',lp:'lp',hrdf:'hrdf'};
 for(const [destination,property]of Object.entries(statutory)){const original=values.statutory[property];if(original!==undefined&&typeof original!=='number'&&typeof original!=='string')return false;try{if(total(destination)!==historyMoneyCents(String(original??0)))return false;}catch{return false;}}
 return true;
}
