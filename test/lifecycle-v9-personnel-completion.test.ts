import {recordSigningAction,signingComplete} from '../lib/document-signing-model';
import {expect,it} from 'vitest';
import {personnelMergeGroups} from '../lib/lifecycle-v9-personnel-merge-fields';
import {effectivePersonnelCompletion,initializePersonnelCompletion,missingPersonnelCompletion,overridePersonnelCompletion,personnelCompletionClassification,personnelCompletionGroup,reconcilePersonnelCompletion,savePersonnelCompletionValue,validateCompletionPhone,personnelCompletionMergeValues,validatePersonnelCompletionScalar,type CompletionDocument} from '../lib/lifecycle-v9-personnel-completion';
import type {Field} from '../lib/lifecycle-v9-model';
import {savePersonnelCompletionAnswer,personnelCompletionEmployeeAnswers} from '../lib/lifecycle-v9-personnel-completion';
const actor={id:'employee',name:'Fictional employee'},hr={id:'hr',name:'Fictional HR'},at='2026-11-18T02:00:00Z';
const field=(id:string,key:string,type:Field['type']='text'):Field=>({id,label:id,type,owner:'pmLocked',pmKey:key,required:true,sensitive:false,options:[],section:'main',when:null});
function fixture(){const fields=[field('address','address'),field('name','employee.name'),field('phone','mobile','phone'),field('new','future.field')],document:CompletionDocument={fields,values:{name:'Official name'},status:'draft',sentAt:null,employeeSignature:null,hrSignature:null};initializePersonnelCompletion(document,{country:'MY',sourceFingerprint:'source-1',officialValues:{name:'Official name'},actor:hr,at});return document;}
it('classifies exactly the 20 approved source keys into 11 personal and nine employment fields, with unknown keys held by HR',()=>{
 expect(Object.keys(personnelCompletionClassification).sort()).toEqual(personnelMergeGroups.flatMap(g=>g.fields.map(f=>f.key)).sort());expect(Object.values(personnelCompletionClassification).filter(g=>g==='personal')).toHaveLength(11);expect(Object.values(personnelCompletionClassification).filter(g=>g==='employment')).toHaveLength(9);expect(personnelCompletionGroup('new.key')).toBe('unknown');const d=fixture();expect(d.fields.map(f=>effectivePersonnelCompletion(d,f))).toEqual(['employee','pmLocked','employee','hr']);expect(d.fields.every(f=>f.owner==='pmLocked')).toBe(true);
});
it('uses the authorized official source rather than case values, and never activates the new rule on a legacy released snapshot',()=>{
 const d=fixture();expect(()=>savePersonnelCompletionValue(d,d.fields[1],'Invented name',{actor,at})).toThrow('locked');const released={...d,personnelCompletion:undefined,sentAt:at,status:'sent' as const};expect(()=>initializePersonnelCompletion(released,{country:'MY',sourceFingerprint:'source-2',officialValues:{},actor:hr,at})).toThrow('unreleased');
});
it('records per-document overrides and preserves the prior employee draft when HR takes completion back',()=>{
 const d=fixture();savePersonnelCompletionValue(d,d.fields[0],'Employee draft address',{actor,at});overridePersonnelCompletion(d,{fieldId:'address',owner:'hr',reason:'HR will verify this address',actor:hr,at});expect(d.values.address).toBe('');expect(d.personnelCompletion?.fields.address.draft?.value).toBe('Employee draft address');expect(missingPersonnelCompletion(d,'hr').map(f=>f.id)).toContain('address');expect(d.personnelCompletion?.history.at(-1)).toMatchObject({fieldId:'address',by:hr,action:'override'});expect(()=>overridePersonnelCompletion(d,{fieldId:'name',owner:'employee',reason:'Override official value',actor:hr,at})).toThrow('missing');
});
it('relocks a still-editable missing field when PM receives a value, preserving a conflicting saved draft for review',()=>{
 const d=fixture();savePersonnelCompletionValue(d,d.fields[0],'Employee draft',{actor,at});expect(reconcilePersonnelCompletion(d,{values:{name:'Official name',address:'New official address'},sourceFingerprint:'source-2',actor:hr,at})).toBe(true);expect(d.values.address).toBe('New official address');expect(effectivePersonnelCompletion(d,d.fields[0])).toBe('pmLocked');expect(d.personnelCompletion?.fields.address.conflict).toEqual({draft:'Employee draft',official:'New official address',at});expect(()=>savePersonnelCompletionValue(d,d.fields[0],'Replacement',{actor,at})).toThrow('locked');
});
it('keeps signed content and its completion evidence immutable when the official profile later changes',()=>{
 const d=fixture();d.employeeSignature={by:actor,at,method:'typed',value:actor.name,consent:true};const before=structuredClone(d);expect(reconcilePersonnelCompletion(d,{values:{name:'Changed official name'},sourceFingerprint:'source-2',actor:hr,at})).toBe(false);expect(d).toEqual(before);
});
it('never attributes an HR replacement to the preserved employee draft, including a hand-back to the employee',()=>{
 const d=fixture();savePersonnelCompletionValue(d,d.fields[0],'Employee address',{actor,at});
 expect(personnelCompletionEmployeeAnswers(d,actor.id)).toEqual([{fieldId:'address',key:'address',value:'Employee address',by:actor,at}]);
 overridePersonnelCompletion(d,{fieldId:'address',owner:'hr',reason:'Verified by HR',actor:hr,at});
 savePersonnelCompletionAnswer(d,d.fields[0],'HR replacement',{owner:'hr',actor:hr,at});
 expect(d.personnelCompletion!.fields.address.draft!.by).toEqual(actor);
 expect(d.personnelCompletion!.fields.address.answer).toMatchObject({owner:'hr',by:hr});
 expect(personnelCompletionEmployeeAnswers(d,actor.id)).toEqual([]);
 overridePersonnelCompletion(d,{fieldId:'address',owner:'employee',reason:'Ask employee again',actor:hr,at});
 expect(d.values.address).toBe('');expect(personnelCompletionEmployeeAnswers(d,actor.id)).toEqual([]);
 savePersonnelCompletionValue(d,d.fields[0],'Fresh employee address',{actor,at});
 expect(personnelCompletionEmployeeAnswers(d,actor.id)[0].value).toBe('Fresh employee address');
 expect(personnelCompletionEmployeeAnswers(d,hr.id)).toEqual([]);
 reconcilePersonnelCompletion(d,{values:{address:'New official address',name:'Official name'},sourceFingerprint:'new',actor:hr,at});
 expect(personnelCompletionEmployeeAnswers(d,actor.id)).toEqual([]);
});
it('validates jurisdiction and numbering prefixes, not only phone length, and applies scalar checks to nonempty draft answers',()=>{
 expect(()=>validateCompletionPhone('0123456789','MY')).not.toThrow();expect(()=>validateCompletionPhone('+6581234567','MY')).not.toThrow();for(const value of ['12345','0001234567','not a phone'])expect(()=>validateCompletionPhone(value,'MY')).toThrow();expect(()=>validateCompletionPhone('0123456789',null)).toThrow('international');expect(()=>validateCompletionPhone('+60123456789',null)).not.toThrow();
 expect(()=>validatePersonnelCompletionScalar(field('mail','personalEmail','email'),'invalid','MY')).toThrow();expect(()=>validatePersonnelCompletionScalar(field('date','custom','date'),'2026-02-30','MY')).toThrow();expect(()=>validatePersonnelCompletionScalar(field('date','custom','date'),'2028-02-29','MY')).not.toThrow();expect(()=>validatePersonnelCompletionScalar(field('number','custom','number'),'0xFF','MY')).toThrow();expect(()=>savePersonnelCompletionValue(fixture(),field('phone','mobile','phone'),'12345',{actor,at})).toThrow();
});

it('resolves field-ID aliases from a refreshed official source consistently and treats whitespace-only source as missing',()=>{
 const d=fixture();d.fields[0].id='F51';d.values.F51='';d.personnelCompletion!.fields.F51=d.personnelCompletion!.fields.address;delete d.personnelCompletion!.fields.address;savePersonnelCompletionValue(d,d.fields[0],'Saved address',{actor,at});expect(personnelCompletionMergeValues(d).address).toBe('Saved address');reconcilePersonnelCompletion(d,{values:{name:'Official name',F51:'Official refreshed address'},sourceFingerprint:'source-2',actor:hr,at});expect(personnelCompletionMergeValues(d).address).toBe('Official refreshed address');d.personnelCompletion!.fields.F51.sourceValue='   ';expect(effectivePersonnelCompletion(d,d.fields[0])).toBe('employee');expect(personnelCompletionMergeValues(d).address).toBe('Official refreshed address');
});

it('defensively distinguishes a synthetic kernel completion without a receipt from an actual signature lock',()=>{
 // This kernel state is synthetic: the current template publisher requires a required Sign step.
 // Optional steps can act only before the final required stage completes.
 const d=fixture();d.signing={tenantId:'tenant',companyId:'company',subjectId:'document',subjectType:'lifecycle_v9',contentRevision:1,contentHash:'hash',route:{version:1,steps:[{id:'review',role:'people',kind:'review',stage:1,holderId:hr.id,holderPersonId:'hr-person',required:true},{id:'approve',role:'employee',kind:'approve',stage:2,holderId:actor.id,holderPersonId:'employee-person',required:true},{id:'optional-sign',role:'people',kind:'sign',stage:2,holderId:hr.id,holderPersonId:'hr-person',required:false}]},actions:[],routing:{templateId:'form',templateVersion:1,caseOwnerId:hr.id,fallbackGroupId:null}};
 d.signing=recordSigningAction(d.signing,{requiredRoles:[]},{id:'reviewed',stepId:'review',revision:1,hash:'hash',action:'reviewed',actorId:hr.id,actorPersonId:'hr-person',actorName:hr.name,at});const beforeFinalDecision=structuredClone(d.signing);
 d.signing=recordSigningAction(d.signing,{requiredRoles:[]},{id:'approved',stepId:'approve',revision:1,hash:'hash',action:'approved',actorId:actor.id,actorPersonId:'employee-person',actorName:actor.name,at});expect(signingComplete(d.signing,{requiredRoles:[]})).toBe(true);d.status='signed';
 expect(()=>savePersonnelCompletionValue(d,d.fields[0],'Still unsigned answer',{actor,at})).not.toThrow();
 d.signing=recordSigningAction(beforeFinalDecision,{requiredRoles:[]},{id:'signed',stepId:'optional-sign',revision:1,hash:'hash',action:'signed',actorId:hr.id,actorPersonId:'hr-person',actorName:hr.name,at,method:'typed',value:hr.name,consent:true});
 expect(()=>savePersonnelCompletionValue(d,d.fields[0],'Changed after actual signature',{actor,at})).toThrow('locked');
});
