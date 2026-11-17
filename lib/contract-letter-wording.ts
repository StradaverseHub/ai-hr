import {CONTRACT_AUTOMATION_CATALOGUE} from './automation/catalogues/contracts';
import type {Document} from './lifecycle-v9-model';

/** Contract wording only. Legacy document/email merge behavior is deliberately untouched. */
export const contractWordingFields=CONTRACT_AUTOMATION_CATALOGUE.mergeFields;
const labels=new Map(contractWordingFields.map(field=>[field.key,field.label]));
const keys=new Map(contractWordingFields.flatMap(field=>[[field.key.toLowerCase(),field.key] as const,[field.label.toLowerCase(),field.key] as const]));
const prototypeAliases:Record<string,string>={'employee.no':'employee.id','employee.position':'employee.jobTitle','employee.company':'org.company','employee.bg':'org.businessGroup','employee.dept':'org.department','employee.supervisor':'people.lineManager','contract.lastDay':'contract.end','employee name':'employee.name','employee id':'employee.id','job title':'employee.jobTitle','contract start date':'contract.start','contract end date':'contract.end','basic salary':'contract.salary','decision notes':'contract.reason',"today’s date":'today',"today's date":'today'};
for(const [alias,key] of Object.entries(prototypeAliases))keys.set(alias.toLowerCase(),key);
const token=/\{([^{}\n]+)\}/g;
export function contractWordingKeys(text:string):string{
 return text.replace(token,(original,name:string)=>{const key=keys.get(name.trim().toLowerCase());return key?`{${key}}`:original;});
}
export function contractWordingLabels(text:string):string{
 return text.replace(token,(original,key:string)=>labels.has(key)?`{${labels.get(key)}}`:original);
}
export function contractUnknownFields(texts:string[],knownKeys:Iterable<string>=[]):string[]{
 const known=new Set([...labels.keys(),...knownKeys]);
 return [...new Set(texts.flatMap(text=>[...text.matchAll(token)].flatMap(match=>{
  const name=match[1],key=keys.get(name.trim().toLowerCase())??name;
  return known.has(key)?[]:[match[0]];
 })))];
}
export function contractLetterDocument(document:Document):Document{
 const texts=document.blocks.flatMap(block=>[block.text,block.rows,block.columns,block.label].filter((text):text is string=>typeof text==='string'));
 const unknown=contractUnknownFields(texts,[...Object.keys(document.mergeValues??{}),...document.fields.map(field=>field.id)]);
 // The shared renderer performs one merge pass. Supplying the original literal preserves unknown
 // Contract tokens without changing that renderer, source values, retained snapshot or fingerprint.
 return {...document,blocks:document.blocks.map(block=>({...block,text:contractWordingKeys(block.text),...(block.rows!==undefined?{rows:contractWordingKeys(block.rows)}:{})})),mergeValues:{...document.mergeValues,...Object.fromEntries(unknown.map(value=>[value.slice(1,-1),value]))}};
}
