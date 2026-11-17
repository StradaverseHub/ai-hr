import {CONTRACT_AUTOMATION_CATALOGUE} from './automation/catalogues/contracts';
import type {Document} from './lifecycle-v9-model';

export type ContractWordingField={key:string;label:string;group:string};
/** Contract only; private PM fields never enter the shared email/global picker. */
export const contractWordingFields:readonly ContractWordingField[]=CONTRACT_AUTOMATION_CATALOGUE.mergeFields;
const prototypeAliases:Record<string,string>={'employee.no':'employee.id','employee.position':'employee.jobTitle','employee.company':'org.company','employee.bg':'org.businessGroup','employee.dept':'org.department','employee.supervisor':'people.lineManager','contract.lastDay':'contract.end','employee name':'employee.name','employee id':'employee.id','job title':'employee.jobTitle','contract start date':'contract.start','contract end date':'contract.end','basic salary':'contract.salary','decision notes':'contract.reason',"today’s date":'today',"today's date":'today'};
const token=/\{([^{}\n]+)\}/g;
function dictionary(fields:readonly ContractWordingField[]){
 const labels=new Map(fields.map(field=>[field.key,field.label])),keys=new Map(fields.flatMap(field=>[[field.key.toLowerCase(),field.key] as const,[field.label.toLowerCase(),field.key] as const]));
 for(const [alias,key] of Object.entries(prototypeAliases))if(labels.has(key))keys.set(alias.toLowerCase(),key);
 // These are aliases of the SAME published selected country fact, never additional PM sources.
 for(const [short,long] of [['icNo','employee.icNo'],['passportNo','employee.passportNo']]){
  if(labels.has(short)&&!labels.has(long))keys.set(long.toLowerCase(),short);
  if(labels.has(long)&&!labels.has(short))keys.set(short.toLowerCase(),long);
 }
 return {labels,keys};
}
export function contractDocumentWordingFields(document:Document|null,selectedKeys:Iterable<string>=Object.keys(document?.mergeValues??{})):ContractWordingField[]{
 const selected=new Set(selectedKeys),isForm=!!document?.blocks.some(block=>block.type==='field'||block.type==='fields');
 const fields=contractWordingFields.filter(field=>!isForm||selected.has(field.key)),seen=new Set(fields.map(field=>field.key)),labels=new Set(fields.map(field=>field.label.toLowerCase()));
 for(const field of document?.fields??[]){
  const key=field.pmKey??field.id;
  // Only published field metadata and the native selected-source projection supply this dictionary.
  if(seen.has(key)||field.pmKey&&!selected.has(key))continue;
  let label=field.label,index=2;while(labels.has(label.toLowerCase())){label=field.label+' ('+index+')';index+=1;}
  fields.push({key,label,group:'This Form'});seen.add(key);labels.add(label.toLowerCase());
 }
 return fields;
}
export function contractWordingKeys(text:string,fields:readonly ContractWordingField[]=contractWordingFields):string{
 const {keys}=dictionary(fields);return text.replace(token,(original,name:string)=>{const key=keys.get(name.trim().toLowerCase());return key?`{${key}}`:original;});
}
export function contractWordingLabels(text:string,fields:readonly ContractWordingField[]=contractWordingFields):string{
 const {keys,labels}=dictionary(fields);return text.replace(token,(original,name:string)=>{const key=keys.get(name.trim().toLowerCase());return key&&labels.has(key)?`{${labels.get(key)}}`:original;});
}
export function contractUnknownFields(texts:string[],knownKeys:Iterable<string>=[],fields:readonly ContractWordingField[]=contractWordingFields):string[]{
 const {keys,labels}=dictionary(fields),known=new Set([...labels.keys(),...knownKeys]);
 return [...new Set(texts.flatMap(text=>[...text.matchAll(token)].flatMap(match=>known.has(keys.get(match[1].trim().toLowerCase())??match[1])?[]:[match[0]])))];
}
export function contractLetterDocument(document:Document):Document{
 const fields=contractDocumentWordingFields(document),texts=document.blocks.flatMap(block=>[block.text,block.rows,block.columns,block.label].filter((text):text is string=>typeof text==='string'));
 const unknown=contractUnknownFields(texts,[...Object.keys(document.mergeValues??{}),...document.fields.map(field=>field.id)],fields);
 // One-pass rendering preserves unknown tokens. The retained source and its verified hash stay unchanged.
 return {...document,blocks:document.blocks.map(block=>({...block,text:contractWordingKeys(block.text,fields),...(block.rows!==undefined?{rows:contractWordingKeys(block.rows,fields)}:{}),...(block.columns!==undefined?{columns:contractWordingKeys(block.columns,fields)}:{}),...(block.label!==undefined?{label:contractWordingKeys(block.label,fields)}:{})})),mergeValues:{...document.mergeValues,...Object.fromEntries(unknown.map(value=>[value.slice(1,-1),value]))}};
}
