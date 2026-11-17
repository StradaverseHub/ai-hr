import {expect,it} from 'vitest';
import {contractWordingKeys,contractWordingLabels,contractUnknownFields,contractLetterDocument} from '../lib/contract-letter-wording';
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
