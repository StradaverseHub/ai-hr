/** Read accepted merged items through the same imported-tax adapter, preserving original monetary ownership. */
import {importedTaxInput,ImportedTaxSourceError,type ImportedTaxSetting} from './payroll-import-tax-input';
import type {HistoryOwnedItem} from './payroll-history-maintenance-lineage';
import type {ImportCodeEntry} from './payroll-history-import-schema';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function maintenanceTaxInput(items:readonly HistoryOwnedItem[],settings:readonly ImportedTaxSetting[],originalLines:unknown){
 const codes=new Map<string,ImportCodeEntry>(),rows:{rowNum:number;code:string;amount:number}[]=[];
 const seen=new Set<string>();
 for(const item of items){
  if(seen.has(item.key))throw new ImportedTaxSourceError('The accepted merged Pay Item identity is duplicated.');seen.add(item.key);
  if(item.direction==='statutory')continue;
  const candidates=settings.filter(setting=>setting.code.trim().toUpperCase()===item.code.trim().toUpperCase());
  if(item.key!=='destination:basic'&&(candidates.length!==1||item.key!=='component:'+candidates[0].id))throw new ImportedTaxSourceError(`The accepted ${item.code} identity no longer matches its Pay Item.`);
  if(item.key==='destination:basic'&&(item.destination!=='basic'||item.code.trim().toUpperCase()!=='BASIC'&&candidates.length!==1))throw new ImportedTaxSourceError('The accepted basic salary field owner is unavailable.');
  const key=item.code.trim().toUpperCase();if(codes.has(key))throw new ImportedTaxSourceError('The accepted merged Pay Item code is ambiguous.');
  codes.set(key,{code:item.code,targetCode:item.code,label:item.label,destination:item.destination,direction:item.direction==='noncash'?'earning':item.direction,source:'component',...(item.key==='destination:basic'?{basicSalaryOwner:true}:{})});
  rows.push({rowNum:rows.length+2,code:item.code,amount:Number(item.amount)});
 }
 const lines=importedTaxInput(rows,codes,settings);
 for(const line of lines){
  const item=items.find(item=>item.code.trim().toUpperCase()===line.code.trim().toUpperCase());
  if(!item||item.direction!==line.direction)throw new ImportedTaxSourceError(`The accepted ${line.code} monetary kind changed. Review the original item.`);
  if(line.direction!=='noncash')continue;
  const candidates=Array.isArray(originalLines)?originalLines.filter(saved=>object(saved)&&saved.settingId===line.settingId&&saved.code===line.code&&saved.amount===line.amount):[];
  const saved=candidates.length===1?candidates[0]:null;
  if(!object(saved)||!object(saved.nonCashSource)||saved.nonCashSource.source!=='one_off'||typeof saved.nonCashSource.sourceId!=='string'||!/^import:[a-f0-9]{64}$/.test(saved.nonCashSource.sourceId))throw new ImportedTaxSourceError(`The accepted ${line.code} original noncash source ownership is unavailable.`);
  line.nonCashSource={source:'one_off',sourceId:saved.nonCashSource.sourceId};
 }
 return lines;
}
