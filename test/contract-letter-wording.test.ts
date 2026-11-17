import {expect,it} from 'vitest';
import {contractDocumentWordingFields,contractWordingKeys,contractWordingLabels,contractUnknownFields,contractLetterDocument} from '../lib/contract-letter-wording';
import {automationDocument} from '../lib/automation-document';
import {merge} from '../lib/lifecycle-v9-model';
import {CONTRACT_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/contracts';
it('round trips readable Contract fields to canonical keys and preserves unknown tokens',()=>{
 const edit='Dear {Full name}, your {Position} at {Company}. Keep {Unrecognised field} and {unknown.key}.';
 const saved=contractWordingKeys(edit);
 expect(saved).toBe('Dear {employee.name}, your {employee.jobTitle} at {org.company}. Keep {Unrecognised field} and {unknown.key}.');
 expect(contractWordingLabels(saved)).toBe(edit);
 expect(contractUnknownFields([edit,saved])).toEqual(['{Unrecognised field}','{unknown.key}']);
});
it('keeps unknown Contract text literal in paragraphs and tables without changing legacy merge or source values',()=>{
 const source=automationDocument({id:'letter',name:'Letter',templateId:'template',templateVersion:1,blocks:[{id:'p',type:'text',text:'{Position}: {unknown.key}',section:''},{id:'table',type:'table',text:'',section:'',columns:'Name | Detail',rows:'{Full name}|{unknown.key}'}],fields:[],merge:{'employee.jobTitle':'Specialist','employee.name':'Fictional Alex'},createdAt:'2026-11-17T00:00:00Z'});
 const before=structuredClone(source),rendered=contractLetterDocument(source);
 expect(merge(rendered.blocks[0].text,rendered.mergeValues!).text).toBe('Specialist: {unknown.key}');
 expect(merge(rendered.blocks[1].rows!,rendered.mergeValues!).text).toBe('Fictional Alex|{unknown.key}');
 expect(source).toEqual(before);
 expect(merge('{unknown.key}',{}).text).toBe('[unknown.key]');
});

it('offers only published native-selected Form sources and uses the same key dictionary for rendering and editing',()=>{
 const fields=[{id:'identity',label:'Identity number',type:'text' as const,owner:'pmLocked' as const,pmKey:'icNo',required:true,sensitive:true,options:[],section:'',when:null},{id:'contact',label:'Emergency contact',type:'text' as const,owner:'employee' as const,pmKey:null,required:false,sensitive:false,options:[],section:'',when:null}];
 const source=automationDocument({id:'form',name:'Fictional selected Form',templateId:'template',templateVersion:1,blocks:[{id:'p',type:'text',text:'Identity {Identity number}; contact {Emergency contact}; unselected {bankAcc}; pay {contract.salary}.',section:''},{id:'fields',type:'fields',text:'',section:''}],fields,merge:{icNo:'FICTIONAL-IDENTITY'},createdAt:'2026-11-17T00:00:00Z'}),before=structuredClone(source),dictionary=contractDocumentWordingFields(source);
 expect(dictionary.some(field=>field.key==='bankAcc'||field.key==='contract.salary')).toBe(false);expect(contractWordingKeys('{Identity number}',dictionary)).toBe('{icNo}');expect(contractWordingLabels('{icNo}',dictionary)).toBe('{Identity number}');expect(contractUnknownFields(['{bankAcc}'],[],dictionary)).toEqual(['{bankAcc}']);
 const output=contractLetterDocument(source);expect(merge(output.blocks[0].text,{...output.mergeValues,contact:'Fictional contact'}).text).toBe('Identity FICTIONAL-IDENTITY; contact Fictional contact; unselected {bankAcc}; pay {contract.salary}.');expect(source).toEqual(before);
});

it('labels paragraph-only country facts only when the native Form projection selected them',()=>{
 const form={blocks:[{id:'fields',type:'fields',text:'',section:''}],fields:[],mergeValues:{bankAcc:'Fictional selected account'}} as unknown as import('../lib/lifecycle-v9-model').Document;
 const fields=contractDocumentWordingFields(form);
 expect(contractWordingKeys('Account {Bank account number}',fields)).toBe('Account {bankAcc}');
 expect(fields.some(field=>field.key==='taxNo')).toBe(false);
 expect(contractWordingKeys('{Tax number}',fields)).toBe('{Tax number}');
});

it('does not reinterpret an already fixed unknown private label through newly available display aliases',()=>{
 const source=automationDocument({id:'fixed',name:'Retained Form',templateId:'template',templateVersion:1,blocks:[{id:'intro',type:'text',text:'Dear {Full name}. Selected {bankAcc}. Originally literal {Bank account number}.',section:''},{id:'fields',type:'fields',text:'',section:''}],fields:[],merge:{bankAcc:'FICTIONAL-RETAINED-ACCOUNT','employee.name':'Fictional retained employee'},createdAt:'2026-11-17T00:00:00Z'});
 const before=structuredClone(source),rendered=contractLetterDocument(source,true);
 expect(merge(rendered.blocks[0].text,rendered.mergeValues??{}).text).toBe('Dear Fictional retained employee. Selected FICTIONAL-RETAINED-ACCOUNT. Originally literal {Bank account number}.');
 expect(source).toEqual(before);
});

it('renders exact retained native label keys once without evaluating braces inside their values or colliding with source tokens',()=>{
 const source=automationDocument({id:'exact-label',name:'Retained Form',templateId:'template',templateVersion:1,blocks:[{id:'p',type:'text',text:'Account {Bank account number}; role {Position}; existing {contractRetained0}; missing {Unknown label}.',section:''},{id:'fields',type:'fields',text:'',section:''}],fields:[],merge:{'Bank account number':'FICTIONAL {contract.salary}','Position':'Retained title','employee.jobTitle':'Another value','contract.salary':'999999',contractRetained0:'Original literal key'},createdAt:'2026-11-17T00:00:00Z'});
 const before=structuredClone(source),rendered=contractLetterDocument(source,true);
 expect(merge(rendered.blocks[0].text,rendered.mergeValues??{}).text).toBe('Account FICTIONAL {contract.salary}; role Retained title; existing Original literal key; missing {Unknown label}.');
 expect(source).toEqual(before);
});

it('preserves static table headings because the shared UI and PDF do not merge those headings',()=>{
 const source=automationDocument({id:'table',name:'Retained table',templateId:'template',templateVersion:1,blocks:[{id:'t',type:'table',text:'',columns:'Field | {Bank account number}',rows:'Account | {Bank account number}',section:''},{id:'fields',type:'fields',text:'',section:''}],fields:[],merge:{'Bank account number':'FICTIONAL-RETAINED'},createdAt:'2026-11-17T00:00:00Z'});
 const rendered=contractLetterDocument(source,true);
 expect(rendered.blocks[0].columns).toBe(source.blocks[0].columns);
 expect(merge(rendered.blocks[0].rows??'',rendered.mergeValues??{}).text).toBe('Account | FICTIONAL-RETAINED');
 expect(rendered.blocks[0].columns).not.toContain('contractRetained');
});

it('keeps old signed wording stable when the live catalogue later changes a label',()=>{
 const live=CONTRACT_AUTOMATION_CATALOGUE.mergeFields.find(field=>field.key==='contract.salary')!,label=live.label;
 const source=automationDocument({id:'old-fixed',name:'Retained Form',templateId:'template',templateVersion:1,blocks:[{id:'p',type:'text',text:'Old {Agreed basic salary}; originally literal {Future salary label}.',section:''},{id:'fields',type:'fields',text:'',section:''}],fields:[],merge:{'contract.salary':'FICTIONAL-AMOUNT'},createdAt:'2026-11-17T00:00:00Z'});
 try{live.label='Future salary label';const fixed=contractLetterDocument(source,true),unsigned=contractLetterDocument(source);expect(merge(fixed.blocks[0].text,fixed.mergeValues??{}).text).toBe('Old FICTIONAL-AMOUNT; originally literal {Future salary label}.');expect(merge(unsigned.blocks[0].text,unsigned.mergeValues??{}).text).toContain('originally literal FICTIONAL-AMOUNT.');}finally{live.label=label;}
});
