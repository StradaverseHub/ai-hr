import {expect,it} from 'vitest';
import {contractDocumentWordingFields,contractWordingKeys,contractWordingLabels,contractUnknownFields,contractLetterDocument} from '../lib/contract-letter-wording';
import {automationDocument} from '../lib/automation-document';
import {merge} from '../lib/lifecycle-v9-model';
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
