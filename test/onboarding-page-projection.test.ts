import {expect,it} from 'vitest';
import {blankCase,defaultConfig,type Actor} from '../lib/onboarding-model';
import {JOINER_SECTION_PRESETS,joinerEditablePatch} from '../lib/onboarding-page-access';
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
