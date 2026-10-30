import {expect,it} from 'vitest';
import {blankCase,defaultConfig,type Actor} from '../lib/onboarding-model';
import {JOINER_SECTION_PRESETS,joinerEditablePatch} from '../lib/onboarding-page-access';
import {defaultV9CaseFields} from '../lib/lifecycle-v9-case-form';
import {projectJoinerPage} from '../lib/onboarding-page-projection';
it('removes hidden case, HR and history values without mutating the canonical case',()=>{
 const env={today:'2026-10-30',now:'2026-10-30T00:00:00Z',id:()=> 'id',nextNumber:()=> 'IT-1',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['viewer']};
 const c=blankCase('case','OB-1','draft',{fullName:'Fictional viewer subject',ic:'PRIVATE-IDENTITY',email:'PRIVATE-CONTACT',department:'PRIVATE-DEPARTMENT'},env);c.floor='PRIVATE-FLOOR';c.caseValues={privateAnswer:'PRIVATE-ANSWER'};c.caseContactEmail='private@example.test';c.notes='PRIVATE-NOTE';c.history=[{id:'history',at:env.now,by:'owner',name:'Owner',action:'case.saved',detail:'PRIVATE-HISTORY'}];
 const before=JSON.stringify(c),config=defaultConfig('owner'),actor:Actor={id:'viewer',name:'Viewer',module:false,hr:false,master:false,sections:JOINER_SECTION_PRESETS.approver};const view=projectJoinerPage(c,config,actor);
 expect(JSON.stringify(view)).not.toContain('PRIVATE-');expect(view.caseContactEmail).toBeUndefined();expect(view.caseValues).toBeUndefined();expect(JSON.stringify(c)).toBe(before);
});
it('prunes payloads to the editable sections while leaving backend authorization independent',()=>{
 expect(joinerEditablePatch({floor:'Hidden',notes:'Hidden',selected:['item'],checklistOverride:'none'},{...JOINER_SECTION_PRESETS.full,case:'hidden',notes:'hidden',checklist:'hidden'})).toEqual({selected:['item']});
});

it('redacts HR-only values for module members independently of full section visibility',()=>{
 const env={today:'2026-10-30',now:'2026-10-30T00:00:00Z',id:()=> 'id',nextNumber:()=> 'IT-1',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['member']};
 const c=blankCase('case','OB-1','draft',{fullName:'Visible name',supervisor:'PRIVATE-MANAGER',ic:'PRIVATE-IC'},env);c.floor='PRIVATE-FLOOR';c.notes='Visible notes';
 const config=defaultConfig('owner');config.v9CaseFields=defaultV9CaseFields('onb');for(const field of config.v9CaseFields)if(['floor','supervisor'].includes(field.key))field.hrOnly=true;
 const actor:Actor={id:'member',name:'Member',module:true,hr:false,master:false};const view=projectJoinerPage(c,config,actor);
 expect(JSON.stringify(view)).not.toContain('PRIVATE-');expect(view.source.fullName).toBe('Visible name');expect(view.notes).toBe('Visible notes');expect(c.floor).toBe('PRIVATE-FLOOR');expect(projectJoinerPage(c,config,{...actor,hr:true}).floor).toBe('PRIVATE-FLOOR');
});
