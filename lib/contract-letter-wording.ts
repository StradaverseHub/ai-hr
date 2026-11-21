import {CONTRACT_AUTOMATION_CATALOGUE} from './automation/catalogues/contracts';
import type {Document} from './lifecycle-v9-model';

export type ContractWordingField={key:string;label:string;group:string};
/** Contract only; private PM fields never enter the shared email/global picker. */
export const contractWordingFields:readonly ContractWordingField[]=CONTRACT_AUTOMATION_CATALOGUE.mergeFields;
// Historical first-sign display dictionary from1f65. New catalogue labels must not reinterpret old signed literals.
const legacyContractWordingFields:readonly ContractWordingField[]=[
 {key:'employee.name',label:'Full name',group:'Employee'},
 {key:'employee.id',label:'Employee number',group:'Employee'},
 {key:'employee.jobTitle',label:'Position',group:'Employee'},
 {key:'org.company',label:'Company',group:'Organisation'},
 {key:'org.businessGroup',label:'Business group',group:'Organisation'},
 {key:'org.department',label:'Department',group:'Organisation'},
 {key:'people.lineManager',label:'Direct Superior',group:'People'},
 {key:'contract.start',label:'Current contract start',group:'Contract'},
 {key:'contract.end',label:'Current contract end',group:'Contract'},
 {key:'contract.number',label:'Contract number',group:'Contract'},
 {key:'contract.newStart',label:'New start date',group:'Decision'},
 {key:'contract.newEnd',label:'New end date',group:'Decision'},
 {key:'contract.term',label:'Term',group:'Decision'},
 {key:'contract.salary',label:'Agreed basic salary',group:'Decision'},
 {key:'contract.reason',label:'Decision reason',group:'Decision'},
 {key:'letter.documentName',label:'Document name',group:'Letter'},
 {key:'letter.signingStep',label:'Signing step',group:'Letter'},
 {key:'letter.sentBackBy',label:'Sent back by',group:'Letter'},
 {key:'letter.sentBackReason',label:'Reason sent back',group:'Letter'},
 {key:'case.link',label:'Link to case',group:'General'},
 {key:'today',label:'Today',group:'General'},
];
// Historical aliases are fixed; new published aliases arrive only as actual native snapshot keys.
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
export function contractDocumentWordingFields(document:Document|null,selectedKeys:Iterable<string>=Object.keys(document?.mergeValues??{}),includeParagraphAliases=true):ContractWordingField[]{
 const selected=new Set(selectedKeys),isForm=!!document?.blocks.some(block=>block.type==='field'||block.type==='fields');
 const fields=(includeParagraphAliases?contractWordingFields:legacyContractWordingFields).filter(field=>!isForm||selected.has(field.key)),seen=new Set(fields.map(field=>field.key)),labels=new Set(fields.map(field=>field.label.toLowerCase()));
 for(const field of document?.fields??[]){
  const key=field.pmKey??field.id;
  // Only published field metadata and the native selected-source projection supply this dictionary.
  if(seen.has(key)||field.pmKey&&!selected.has(key))continue;
  let label=field.label,index=2;while(labels.has(label.toLowerCase())){label=field.label+' ('+index+')';index+=1;}
  fields.push({key,label,group:'This Form'});seen.add(key);labels.add(label.toLowerCase());
 }
 // Paragraph-only selected country facts have no field row, but still need readable labels.
 // This finite Form-only map never selects a source; the native published-source projection does.
 if(isForm&&includeParagraphAliases)for(const [key,label] of Object.entries({icNo:'Identity card number',passportNo:'Passport number',bankName:'Bank name',bankAcc:'Bank account number',epfNo:'EPF number',taxNo:'Tax number','employee.icNo':'Employee identity card number','employee.passportNo':'Employee passport number'})){
  if(!selected.has(key)||seen.has(key))continue;
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
export function contractLetterDocument(document:Document,preserveLegacyDictionary=false):Document{
 const fields=contractDocumentWordingFields(document,Object.keys(document.mergeValues??{}),!preserveLegacyDictionary),texts=document.blocks.flatMap(block=>[block.text,block.rows,block.columns,block.label].filter((text):text is string=>typeof text==='string'));
 const unknown=contractUnknownFields(texts,[...Object.keys(document.mergeValues??{}),...document.fields.map(field=>field.id)],fields);
 const raw:Record<string,string>=document.mergeValues??{},retainedValues:Record<string,string>={},retainedKeys=new Map<string,string>(),reserved=new Set([...Object.keys(raw),...fields.map(field=>field.key),...document.fields.map(field=>field.id),...texts.flatMap(text=>[...text.matchAll(token)].map(match=>match[1]))]);
 function renderKeys(text:string){
  const exact=text.replace(token,(original,name:string)=>{
   // The legacy merger cannot read space-containing keys. Bridge only an ACTUAL retained native key,
   // never interpolate its value into wording (which would recursively evaluate tokens inside that value).
   if(!Object.hasOwn(raw,name)||/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)?$/.test(name)&&contractWordingKeys(original,fields)===original)return original;
   let key=retainedKeys.get(name);if(!key){let index=retainedKeys.size;do{key='contractRetained'+index++;}while(reserved.has(key));reserved.add(key);retainedKeys.set(name,key);retainedValues[key]=raw[name]||'['+name+']';}
   return '{'+key+'}';
  });
  return contractWordingKeys(exact,fields);
 }
 // One-pass rendering preserves unknown tokens. The retained source and its verified hash stay unchanged.
 return {...document,blocks:document.blocks.map(block=>({...block,text:renderKeys(block.text),...(block.rows!==undefined?{rows:renderKeys(block.rows)}:{}),...(block.label!==undefined?{label:renderKeys(block.label)}:{})})),mergeValues:{...raw,...Object.fromEntries(unknown.map(value=>[value.slice(1,-1),value])),...retainedValues}};
}
