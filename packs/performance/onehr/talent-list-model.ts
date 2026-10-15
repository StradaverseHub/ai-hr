import { pmBands,potentialBands,talentCell9,talentColumn,type PMBand,type PotentialBand } from './model';
export const talentListColumns=['name','department','grade','performance','potential','box'] as const;
export type TalentListColumn=typeof talentListColumns[number];
export type TalentListPerson={id:string;name:string;department?:string;grade:string;performance:PMBand|null;potential:PotentialBand|null;moved?:boolean};
export type TalentListFilters=Partial<Record<TalentListColumn,string[]>>;
export type TalentListSort={column:TalentListColumn;direction:1|-1};
const categoryRank:Record<string,number>={'PIP/Improvement':0,'Solid Core':1,Star:2,'Super Star':3};
export function talentListCategory(row:TalentListPerson){return row.performance&&row.potential?talentCell9(talentColumn(row.performance),row.potential):'';}
export function talentListValue(row:TalentListPerson,column:TalentListColumn):string {
 if(column==='box'){const category=talentListCategory(row);return category==='PIP/Improvement'?'PIP':category;}
 return row[column]??'';
}
export function talentListPass(row:TalentListPerson,filters:TalentListFilters,category='',skip?:TalentListColumn){
 if(category&&(category==='Moved'?!row.moved:talentListCategory(row)!==category))return false;
 return talentListColumns.every(c=>c===skip||filters[c]===undefined||filters[c]!.includes(talentListValue(row,c)));
}
/** Source tbColValues: other filters constrain the menu; its selected values stay available. */
export function talentListValues(rows:TalentListPerson[],column:TalentListColumn,filters:TalentListFilters,category=''){
 const values=[...new Set([...rows.filter(r=>talentListPass(r,filters,category,column)).map(r=>talentListValue(r,column)),...(filters[column]??[])])];
 const order:readonly string[]|null=column==='performance'?pmBands:column==='potential'?potentialBands:column==='box'?['Super Star','Star','Solid Core','PIP']:null;
 return values.sort((a,b)=>{if(!a||!b)return a===b?0:!a?1:-1;if(order)return (order.indexOf(a)<0?99:order.indexOf(a))-(order.indexOf(b)<0?99:order.indexOf(b));return a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'});});
}
function sortValue(row:TalentListPerson,column:TalentListColumn):string|number {
 if(column==='performance')return pmBands.indexOf(row.performance!);
 if(column==='potential')return potentialBands.indexOf(row.potential!);
 if(column==='box')return (categoryRank[talentListCategory(row)]??0)*100+Math.max(0,potentialBands.indexOf(row.potential!))*10+['low','mid','high'].indexOf(row.performance?talentColumn(row.performance):'low');
 const value=talentListValue(row,column);return column==='grade'?value:value.toLowerCase();
}
/** Source tbPaintList: descending category by default; natural grade order; blank strings last in either direction. */
export function talentListRows<T extends TalentListPerson>(rows:T[],filters:TalentListFilters,category='',sort:TalentListSort={column:'box',direction:-1}){
 return rows.filter(r=>talentListPass(r,filters,category)).sort((a,b)=>{
  const left=sortValue(a,sort.column),right=sortValue(b,sort.column);
  const order=typeof left==='number'&&typeof right==='number'?(left-right)*sort.direction:!left||!right?left===right?0:!left?1:-1:String(left).localeCompare(String(right),undefined,{numeric:true})*sort.direction;
  return order||a.name.localeCompare(b.name)||a.id.localeCompare(b.id);
 });
}
