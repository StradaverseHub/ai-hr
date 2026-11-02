/** @vitest-environment jsdom */
/** Actual escalation editor controls, independent of database native authority qualification. */
import React from 'react';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {LeaveEscalationEditor,type EscalationLabels} from '../app/admin/leave-approval/escalation-editor';
import en from '../messages/en.json';
afterEach(cleanup);
const t=en.leaveApproval,labels:EscalationLabels={title:t.escalationTitle,hint:t.escalationHint,enable:t.escalationEnable,escalateAfter:t.escalateAfter,workingDaysUnit:t.workingDaysUnit,level:t.escalationLevel,nextLevel:t.escalationNextLevel,specificRole:t.escalationSpecificRole,role:t.escalationRole,notifyNote:t.escalationNotifyNote,save:t.save,reason:t.reason,reasonPlaceholder:t.reasonPlaceholder,roleLabels:{hr_admin:'HR administrator'}};
const initial={enabled:true,escalateAfterDays:4,target:'next_level' as const,targetRole:null},action=vi.fn(async(_fd:FormData)=>{});
it('retains the actual stored escalation settings with every mutation control disabled for View only',()=>{
 const {container}=render(<LeaveEscalationEditor companyId="fictional-company" canWrite={false} initial={initial} action={action} labels={labels}/>);
 expect(screen.getByDisplayValue('4')).toBeTruthy();
 const controls=Array.from(container.querySelectorAll('input:not([type="hidden"]),select,button'));expect(controls.length).toBeGreaterThan(5);for(const control of controls)expect(control.matches(':disabled')).toBe(true);
 expect(action).not.toHaveBeenCalled();
});
it('enables the actual Edit course while retaining the native role-target dependency',()=>{
 render(<LeaveEscalationEditor companyId="fictional-company" canWrite={true} initial={initial} action={action} labels={labels}/>);
 expect(screen.getByRole('spinbutton').matches(':disabled')).toBe(false);expect(screen.getByRole('button',{name:t.save}).matches(':disabled')).toBe(false);
 expect(screen.getByRole('combobox').matches(':disabled')).toBe(true);
 fireEvent.click(screen.getByRole('radio',{name:t.escalationSpecificRole}));expect(screen.getByRole('combobox').matches(':disabled')).toBe(false);
 expect(action).not.toHaveBeenCalled();
});
