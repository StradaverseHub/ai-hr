import { expect, it } from 'vitest';
import { defaultConfig, blankCase, saveCase, missingCaseFields, type Actor, type Environment } from '../lib/onboarding-model';
import { defaultV9CaseFields } from '../lib/lifecycle-v9-case-form';
function fixture(){const config=defaultConfig('hr');config.v9CaseFields=defaultV9CaseFields('onb');const env:Environment={today:'2026-10-30',now:'2026-10-30T00:00:00Z',id:()=>crypto.randomUUID(),nextNumber:()=>'',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['hr']};const actor:Actor={id:'hr',name:'HR',module:true,hr:true,master:true};const c=blankCase('case','OB-FICTIONAL','draft',{fullName:'Fictional employee',joinDate:'2026-11-02',company:'company'},env);return{config,env,actor,c};}
it('locks even an unsupplied Personnel field while retaining a previously stored case value',()=>{const{config,env,actor,c}=fixture();expect(()=>saveCase(config,c,{local:{employeeId:'FORGED'}},actor,env)).toThrow('Personnel Management');c.local.supervisor='retained-manager';expect(()=>saveCase(config,c,{local:{supervisor:'retained-manager'}},actor,env)).not.toThrow();expect(()=>saveCase(config,c,{local:{supervisor:'different-manager'}},actor,env)).toThrow('Personnel Management');});
it('applies visibility and HR-only requirements without granting ordinary editors HR answers',()=>{const{config,env,actor,c}=fixture();config.v9CaseFields!.push({key:'privateNote',label:'Private HR note',type:'text',show:true,required:true,hrOnly:true,rules:{},options:[],help:''});c.hiring='new_hire';expect(missingCaseFields(c,config,true)).toEqual(['privateNote']);expect(missingCaseFields(c,config,false)).toEqual([]);expect(()=>saveCase(config,c,{caseValues:{privateNote:'Unauthorized'}},{...actor,hr:false},env)).toThrow('HR access');});

it.each([['hiring','hireType'],['replacedEmployee','replacing'],['floor','floor'],['notes','notes']])('protects configured HR-only scalar %s from group and module writers',(key,fieldKey)=>{
 const {config,env,actor,c}=fixture();const field=config.v9CaseFields!.find(field=>field.key===fieldKey)!;field.hrOnly=true;
 expect(()=>saveCase(config,c,{[key]:'FORGED'},{...actor,hr:false},env)).toThrow('Company HR access');
 expect((c as unknown as Record<string,unknown>)[key]).not.toBe('FORGED');
});
