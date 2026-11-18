import {createHash} from 'node:crypto';
import {renderLetterDocument,validateLetterDocument,type LetterField,type LetterDocument,type LetterValue} from './letter-model';
import {renderLetterPdf} from './letter-pdf';
import type {ContractCase} from './contract-management-model';
import {ContractManagementError} from './contract-management-model';
import {CONTRACT_FIELDS} from './contract-management-template-model';
export {CONTRACT_FIELDS,CONTRACT_DOCUMENT_TYPES} from './contract-management-template-model';
export type {ContractDocumentType} from './contract-management-template-model';
export type ContractDocumentFacts={name:string;employeeId:string;designation:string;grade:string;department:string;businessGroup:string;company:string;manager:string;signatoryName:string;signatoryTitle:string};
const rm=(cents:string)=>{const n=BigInt(cents);return `${n/BigInt(100)}.${(n%BigInt(100)).toString().padStart(2,'0')}`;};
export function contractMergeValues(record:ContractCase,facts:ContractDocumentFacts,today:string):Record<string,LetterValue>{
 const d=record.decision,values:Record<string,LetterValue>={};
 const text:Record<string,string>={'employee.name':facts.name,'employee.id':facts.employeeId,'employee.designation':facts.designation,'employee.grade':facts.grade,'employee.department':facts.department,'employee.businessGroup':facts.businessGroup,'employee.company':facts.company,'employee.manager':facts.manager,'contract.type':record.term.kind,'contract.term':String(d?.months??''),'pay.changed':String(!!d&&(d.salaryCents!==record.term.salaryCents||d.allowanceCents!==record.term.allowanceCents)),'document.signatoryName':facts.signatoryName,'document.signatoryTitle':facts.signatoryTitle};
 for(const [key,value] of Object.entries(text))values[key]={kind:'text',value};
 for(const [key,value] of Object.entries({'contract.start':record.term.startOn,'contract.end':record.term.endOn,'contract.newStart':d?.startOn,'contract.newEnd':d?.endOn,'contract.lastWorkingDay':record.term.endOn,'document.issueDate':today}))if(value)values[key]={kind:'date',value};
 values['pay.basicSalary']={kind:'currency',value:rm(d?.salaryCents??record.term.salaryCents),currency:'MYR'};values['pay.fixedAllowance']={kind:'currency',value:rm(d?.allowanceCents??record.term.allowanceCents),currency:'MYR'};return values;
}
export function validateContractTemplate(raw:unknown):LetterDocument{return validateLetterDocument(raw,CONTRACT_FIELDS);}
export async function renderContractDocument(input:{record:ContractCase;facts:ContractDocumentFacts;document:LetterDocument;today:string;letterhead?:Uint8Array;title:string}){
 if(!input.facts.signatoryName||!input.facts.signatoryTitle)throw new ContractManagementError('invalid','Set the legal entity signatory before generation.');
 const values=contractMergeValues(input.record,input.facts,input.today),resolved=renderLetterDocument(input.document,CONTRACT_FIELDS,values,{allowSensitive:true});
 const rendered=await renderLetterPdf({document:resolved.document,reference:input.record.number,title:input.title,letterhead:input.letterhead,signature:{name:input.facts.signatoryName,caption:input.facts.signatoryTitle,timestamp:input.today}});
 return {pdf:Buffer.from(rendered.bytes),hash:createHash('sha256').update(rendered.bytes).digest('hex'),values,resolved:resolved.document};
}
export function exportContractTemplates(templates:unknown[]){return JSON.stringify({format:'aihr.contract-templates',version:1,fields:CONTRACT_FIELDS.map(f=>({key:f.key,kind:f.kind,futureLetterSource:f.source})),templates},null,2);}

export function validateContractTemplateForIssue(type:import('./contract-management-template-model').ContractDocumentType,raw:unknown):LetterDocument{
 const document=validateContractTemplate(raw),present=new Set<string>();
 const visit=(value:unknown)=>{if(!value||typeof value!=='object')return;const node=value as Record<string,unknown>;if(node.type==='if')return;if(node.type==='field'&&typeof node.key==='string')present.add(node.key);for(const child of Object.values(node))if(Array.isArray(child))child.forEach(visit);else visit(child);};
 document.blocks.forEach(visit);const required=type==='renewal'?['employee.name','employee.id','contract.newStart','contract.newEnd','pay.basicSalary','pay.fixedAllowance']:['employee.name','employee.id','contract.lastWorkingDay'];
 if(required.some(key=>!present.has(key)))throw new ContractManagementError('invalid','Include the employee identity and all issued contract dates and pay terms outside conditional blocks.');return document;
}
