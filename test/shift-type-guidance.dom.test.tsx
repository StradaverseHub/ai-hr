import {expect,it,vi} from 'vitest';
import {fireEvent,render,screen} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const catalog=vi.hoisted(()=>({locale:'en',messages:{} as typeof en}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:catalog.locale,messages:catalog.messages,namespace:namespace as never,onError:error=>{throw error;}})}));
vi.mock('../components/attendance-settings-navigation',()=>({AttendanceSettingsNavigation:()=>null}));
vi.mock('../app/(app)/admin/attendance/shift-actions',()=>({createShiftAction:vi.fn(),updateShiftAction:vi.fn()}));
import {ShiftForm,type ShiftRow} from '../app/(app)/admin/attendance/shift-form';

const shift:ShiftRow={id:'full-flexi-guidance',name:'Fictional Full Flexi',code:'FF-GUIDANCE',type:'full_flexi',startTime:null,endTime:null,
  normalMinutesOverride:480,breakMinutes:30,breakPeriods:[{start:'12:00',end:'13:00',flexible:true,flexibleMinutes:30}],
  weeklyPattern:[1,2,3,4,5],halfPattern:[],offPattern:[],ruleId:null,color:null,description:null,
  tenantId:'11111111-1111-1111-1111-111111111111',companyId:null,allowedRuleIds:[],
  dailyCutoffEnabled:false,dailyCutoffTime:null,crossesMidnight:false,
  lateGraceMinutes:null,earlyLeaveGraceMinutes:null,otRule:null,differential:null,
  dayType:null,category:null,earlyIn:null,lateOut:null,lateOutNextDay:null,
  fullDayLeaveMinutes:null,normalHoursRoundingMinutes:null,fullDayOtMinutes:null,
  halfDayFirstOut:null,halfDaySecondIn:null,flexibleBreakEnabled:false,flexibleBreakMinutes:null,
  archivedAt:null,createdAt:new Date('2026-01-01T00:00:00Z'),updatedAt:new Date('2026-01-01T00:00:00Z'),
};

for(const [locale,messages] of [['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viMessages]] as const){
  it(`${locale}: the whole form gives duration-only Full Flexi guidance and switches fixed/Semi guidance with the live type`,async()=>{
    catalog.locale=locale;catalog.messages=messages as typeof en;
    const notes=messages.admin.attendancePolicy;
    render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}>{await ShiftForm({shift,otWindows:[],ruleOptions:[]})}</NextIntlClientProvider>);
    expect(screen.getByText(messages.boardSchedule.fullFlexiHint)).toBeVisible();
    expect(screen.getByText(notes.clockingWindowCutoffNote)).toBeVisible();
    expect(screen.queryByText(notes.shiftTypeFullFlexiNote)).toBeNull();
    expect(screen.queryByText(notes.shiftTimeSequenceHint)).toBeNull();
    expect(screen.queryByText(notes.shiftHint)).toBeNull();
    expect(screen.queryByText(notes.shiftTypeSemiFlexiNote)).toBeNull();
    expect(screen.getByText(notes.breakPaidHint)).toBeVisible();

    const type=screen.getByRole('combobox',{name:notes.shiftTypeLabel});
    for(const fixedType of ['normal','semi_flexi']){
      fireEvent.change(type,{target:{value:fixedType}});
      expect(screen.getByText(notes.shiftTimeSequenceHint)).toBeVisible();
      expect(screen.getByText(notes.shiftHint)).toBeVisible();
      expect(screen.getByText(notes.shiftTypeSemiFlexiNote)).toBeVisible();
      expect(screen.queryByText(notes.shiftTypeFullFlexiNote)).toBeNull();
      fireEvent.change(type,{target:{value:'full_flexi'}});
      expect(screen.getByText(messages.boardSchedule.fullFlexiHint)).toBeVisible();
      expect(screen.queryByText(notes.shiftTimeSequenceHint)).toBeNull();
      expect(screen.queryByText(notes.shiftHint)).toBeNull();
      expect(screen.queryByText(notes.shiftTypeSemiFlexiNote)).toBeNull();
    }
  });
}
