import {describe,expect,it} from 'vitest';
import {validateProbationLetterFields,probationLetterDocument} from '../lib/probation-letter-document';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import type {SigningDocument,SigningAction} from '../lib/document-signing-model';
const template=newProbationLetterTemplate('confirm','template','Confirmation letter'),hash='a'.repeat(64);
function input(){return{id:'part',name:template.name,templateId:template.id,templateVersion:3,blocks:structuredClone(template.blocks),fields:[{id:'name',label:'Employee',type:'text' as const,owner:'pmLocked' as const,pmKey:'employeeName',required:true,sensitive:false,options:[],section:'main',when:null},{id:'reference',label:'Reference',type:'text' as const,owner:'hr' as const,pmKey:null,required:true,sensitive:false,options:[],section:'main',when:null}],merge:{employeeName:'Fictional Employee',companyName:'Fictional Company',reference:'HR-2026-001'},createdAt:'2026-11-03T00:00:00Z'};}
function action(stepId:string,role:string,revision=1):SigningAction{return{id:'action-'+stepId,stepId,role,actorId:role+'-login',actorPersonId:role+'-person',actorName:role==='employee'?'Fictional Employee':'Fictional PBP',representedId:role+'-login',at:'2026-11-03T00:01:00Z',action:'signed',comment:'',contentRevision:revision,contentHash:hash,signature:{method:'typed',value:role==='employee'?'Fictional Employee':'Fictional PBP',consent:true}};}
function signed():SigningDocument{return{tenantId:'tenant',companyId:'company',subjectId:'part',subjectType:'probation',contentRevision:1,contentHash:hash,route:{version:1,steps:template.route.steps.map(step=>({...step,holderId:step.role+'-login'}))},actions:[action('pbp','pbp'),action('employee','employee')]};}
describe('probation frozen letter projection',()=>{
 it('uses canonical locked facts and declared HR values without modifying the source snapshot',()=>{const source=input(),document=probationLetterDocument(source);expect(document.values).toEqual({name:'Fictional Employee',reference:'HR-2026-001'});expect(document.mergeValues?.['company.name']).toBe('Fictional Company');expect(document.status).toBe('draft');expect(document.mergeValues).toMatchObject({acknowledgedBy:'',acknowledgedOn:''});document.blocks[0].text='Changed preview';expect(source.blocks[0].text).toBe('');});
 it('projects authenticated current signers and retains the exact selected template version',()=>{const document=probationLetterDocument({...input(),signing:signed()});expect(document.mergeValues).toMatchObject({acknowledgedBy:'Fictional Employee',acknowledgedOn:'2026-11-03T00:01:00Z'});expect(document).toMatchObject({version:3,status:'signed',hrSignature:{by:{name:'Fictional PBP'}},employeeSignature:{by:{name:'Fictional Employee'}}});});
 it('cannot reuse signatures from the previous content revision',()=>{const signing=signed();signing.contentRevision=2;const document=probationLetterDocument({...input(),signing});expect(document.status).toBe('draft');expect(document.hrSignature).toBeNull();expect(document.employeeSignature).toBeNull();expect(signing.actions).toHaveLength(2);});
});


describe('required outcome letter fields',()=>{
 const field:import('../lib/lifecycle-v9-model').Field={id:'note',label:'Review note',type:'text',owner:'hr',pmKey:null,required:true,sensitive:false,options:[],section:'main',width:'full',columns:[],when:null};
 it('refuses missing required values and unchecked consent while allowing hidden conditional fields',()=>{
  expect(()=>validateProbationLetterFields([field],{})).toThrow(/required visible/);
  expect(()=>validateProbationLetterFields([{...field,type:'checkbox'}],{note:'false'})).toThrow(/required visible/);
  expect(()=>validateProbationLetterFields([{...field,when:{field:'choice',value:'yes'}}],{})).not.toThrow();
 });
 it('refuses empty or malformed required tables, and accepts typed visible values',()=>{
  const table={...field,type:'table' as const,columns:['Evidence']};expect(()=>validateProbationLetterFields([table],{note:'[]'})).toThrow(/required visible/);expect(()=>validateProbationLetterFields([table],{note:'not-json'})).toThrow();expect(()=>validateProbationLetterFields([table],{note:'[["Reviewed evidence"]]'})).not.toThrow();
 });
});
