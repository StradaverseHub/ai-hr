import {expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import type {SessionContext} from '../db/client';
import type {AttendanceRuleView} from '../core/attendance-rule';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';

const catalog=vi.hoisted(()=>({locale:'en',messages:{} as typeof en}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:catalog.locale,messages:catalog.messages,namespace:namespace as never,onError:error=>{throw error;}})}));
vi.mock('../core/attendance-rule',()=>({countEmploymentsInRule:async()=>0}));
vi.mock('../core/schedule-group-controls',()=>({scheduleGroupControls:async()=>({label:null,dutyRosterControl:false,revisions:[]})}));
vi.mock('../components/attendance-settings-navigation',()=>({AttendanceSettingsNavigation:()=>null}));
vi.mock('../app/(app)/admin/attendance-policy/rule-actions',()=>({createAttendanceRuleAction:vi.fn(),updateAttendanceRuleAction:vi.fn(),saveScheduleGroupGeneralAction:vi.fn()}));
vi.mock('../app/(app)/admin/attendance/schedule/actions',()=>({saveScheduleGroupAttendanceAction:vi.fn(),saveScheduleGroupOvertimeAction:vi.fn(),saveScheduleGroupControlAction:vi.fn()}));
vi.mock('../components/schedule-rotation-editor',()=>({ScheduleRotationEditor:()=>null}));
vi.mock('../packs/attendance/service',()=>({
  getScheduleRotation:async()=>({versions:[],revision:'pool-version',memberships:[{shiftId:'shared-one'},{shiftId:'shared-two'}]}),
  workingShiftSchedule:()=>({normalMinutes:480,shiftEnd:'18:00'}),
}));
vi.mock('../core/roster',()=>({listShiftsForTenant:async()=>['one','two'].map(key=>({
  id:`shared-${key}`,name:`Shared shift ${key}`,code:`SHARED-${key}`,ruleId:'another-default-group',type:'normal',startTime:'09:00',endTime:'18:00',
  crossesMidnight:false,breakMinutes:60,normalMinutesOverride:null,normalHoursRoundingMinutes:null,archivedAt:null,
}))}));
import {ScheduleGroupSections} from '../app/(app)/admin/attendance/schedule/group-sections';

const rule={
  id:'view-group',tenantId:'tenant',companyId:null,name:'Shared-pool group',label:null,description:null,isDefault:false,status:'active',dutyRosterControl:false,
  createdAt:new Date('2026-01-01'),updatedAt:new Date('2026-01-01'),weeklyPattern:[1,2,3,4,5],halfPattern:[],offPattern:[],
  lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,
  earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,
  applyToEarlyOt:false,applyDeductions:false,deductionsEffectiveFrom:null,otRows:[],
} satisfies AttendanceRuleView;

for(const [locale,messages] of [['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viMessages]] as const){
  it(`${locale}: explains shared pool membership without claiming it moves the shift's default group`,async()=>{
    catalog.locale=locale;catalog.messages=messages as typeof en;
    window.history.replaceState({},'','/admin/attendance/schedule/view-group');
    const tree=await ScheduleGroupSections({s:{} as SessionContext,rule,rules:[rule],mode:'view'});
    render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}>{tree}</NextIntlClientProvider>);
    expect(screen.getByText(messages.boardSchedule.groupName)).toBeVisible();
    expect(screen.queryByText(messages.admin.attendanceRule.colName)).toBeNull();
    expect(screen.getByText(messages.admin.rotation.poolHint)).toBeVisible();
    expect(screen.queryByText(messages.admin.attendanceRule.shiftsAllowedHint)).toBeNull();
    expect(screen.getByRole('link',{name:'Shared shift one'})).toBeVisible();
    expect(screen.getByRole('link',{name:'Shared shift two'})).toBeVisible();
  });
}
