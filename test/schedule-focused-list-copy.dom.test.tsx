import {cloneElement,isValidElement,type ReactNode} from 'react';
import {expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const catalog=vi.hoisted(()=>({locale:'en',messages:{} as typeof en}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:catalog.locale,messages:catalog.messages,namespace:namespace as never,onError:error=>{throw error;}})}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('Unexpected redirect '+url);}}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({})}));
vi.mock('../components/attendance-settings-navigation',()=>({AttendanceSettingsNavigation:()=>null}));
vi.mock('../components/legacy-schedule-anchor',()=>({LegacyScheduleAnchor:()=>null}));
vi.mock('../core/attendance-rule',()=>({ensureStandardRule:async()=>{},listAttendanceRules:async()=>[]}));
// The Offline clocking card's server read (DB); its own card is covered by test/offline-clocking-card.dom.test.tsx.
vi.mock('../app/(app)/admin/attendance-policy/offline-clocking-data',()=>({loadOfflineClockingSettings:async()=>[]}));
vi.mock('../app/(app)/admin/attendance-policy/offline-clocking-actions',()=>({saveOfflineClockingAction:vi.fn()}));
vi.mock('../app/(app)/admin/attendance-policy/rule-actions',()=>({copyAttendanceRuleAction:vi.fn(),deleteAttendanceRuleAction:vi.fn(),setAttendanceRuleStatusAction:vi.fn()}));
import Page from '../app/(app)/admin/attendance/schedule/page';
import {ScheduleGroupCard} from '../app/(app)/admin/attendance-policy/schedule-group-card';

/** Resolve the known async server card; all visible UI components still render normally. */
async function resolveCard(node:ReactNode):Promise<ReactNode>{
  if(Array.isArray(node))return Promise.all(node.map(resolveCard));
  if(!isValidElement<{children?:ReactNode}>(node))return node;
  if(node.type===ScheduleGroupCard)return ScheduleGroupCard(node.props as React.ComponentProps<typeof ScheduleGroupCard>);
  return cloneElement(node,{children:await resolveCard(node.props.children)});
}
const focused={
  en:'Open a Schedule Group to view or change its settings.',
  ms:'Buka Kumpulan Jadual untuk melihat atau mengubah tetapannya.',
  zh:'打开排班组以查看或更改其设置。',
  ta:'அட்டவணைக் குழுவின் அமைப்புகளைப் பார்க்க அல்லது மாற்ற அதைத் திறக்கவும்.',
  th:'เปิดกลุ่มตารางงานเพื่อดูหรือเปลี่ยนการตั้งค่า',
  vi:'Mở một nhóm lịch để xem hoặc thay đổi cài đặt của nhóm.',
};
for(const [locale,messages] of [['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viMessages]] as const){
  it(`${locale}: presents the focused group list using Schedule Group Name and no obsolete rule-ownership hint`,async()=>{
    catalog.locale=locale;catalog.messages=messages as typeof en;
    render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}>{await resolveCard(await Page({searchParams:Promise.resolve({})}))}</NextIntlClientProvider>);
    expect(screen.getByRole('columnheader',{name:messages.boardSchedule.groupName})).toBeVisible();
    expect(screen.queryByRole('columnheader',{name:messages.admin.attendanceRule.colName})).toBeNull();
    expect(screen.getByText(focused[locale])).toBeVisible();
    expect(screen.queryByText(messages.admin.attendanceRule.libraryIntro)).toBeNull();
    expect(screen.getByRole('link',{name:messages.admin.attendanceRule.addNew})).toHaveAttribute('href','/admin/attendance/schedule/new');
  });
}
