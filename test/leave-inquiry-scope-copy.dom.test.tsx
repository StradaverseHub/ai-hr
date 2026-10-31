import {cloneElement,isValidElement,type ReactElement,type ReactNode} from 'react';
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
const historyReads=vi.hoisted(()=>vi.fn(async()=>[]));
const people=vi.hoisted(()=>[
  {employmentId:'11111111-1111-4111-8111-111111111111',name:'Inquiry Alpha',employeeCode:'INQ-01',company:'Inquiry Company',companyId:'company',department:'People',departmentId:'department',businessUnit:null,businessUnitId:null,terminatedOn:null},
  {employmentId:'22222222-2222-4222-8222-222222222222',name:'Inquiry Beta',employeeCode:'INQ-02',company:'Inquiry Company',companyId:'company',department:'People',departmentId:'department',businessUnit:null,businessUnitId:null,terminatedOn:null},
]);
vi.mock('next-intl/server',()=>({
  getLocale:async()=>catalog.locale,
  getTranslations:async(namespace:string)=>createTranslator({locale:catalog.locale,messages:catalog.messages,namespace:namespace as never,onError:error=>{throw error;}}),
}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(key:string)=>({value:key.endsWith('-selected')?people[0].employmentId:'1'})})}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:{},scopeIds:['company']})}));
vi.mock('../core/read',()=>({listLeaveTypes:async()=>[]}));
vi.mock('../core/leave',()=>({todayInKualaLumpur:()=> '2026-10-17'}));
vi.mock('../core/ess-view',()=>({isReplacementLeaveType:()=>false}));
vi.mock('../packs/leave/service',()=>({
  leaveInquiryContext:async(_session:unknown,_scope:unknown,query:{emp?:string})=>({employees:people,selected:people.find(person=>person.employmentId===query.emp),companies:[{id:'company',name:'Inquiry Company'}]}),
  leaveInquiryRecordsPage:async()=>({rows:[],total:0}),
  replacementRequestAvailability:async()=>({allowed:false}),
  listEntitlementRecalcAudit:historyReads,
}));
vi.mock('../app/(app)/leave/employee-balances/inquiry-data',()=>({inquiryBalancePage:async()=>({rows:[],total:0})}));
// These controls are outside the copy contract. The actual page, header, shell and picker render below.
vi.mock('../components/filter-panel',()=>({FilterChips:()=>null,FilterPanel:()=>null}));
vi.mock('../components/pager',()=>({Pager:()=>null}));
vi.mock('../components/leave/leave-inquiry-nav',()=>({LeaveInquiryNav:()=>null}));
vi.mock('../components/leave/EntitlementBreakdown',()=>({EntitlementBreakdown:()=>null}));
vi.mock('../components/leave/replacement-availability-notice',()=>({ReplacementAvailabilityNotice:()=>null}));
vi.mock('../components/leave/table-fullscreen',()=>({TableFullscreen:({children}:{children:ReactNode})=><>{children}</>}));
vi.mock('../components/leave/admin-cancel-leave-dialog',()=>({AdminCancelLeaveDialog:()=>null}));
vi.mock('../app/(app)/leave/actions',()=>({adminCancelLeaveAction:vi.fn()}));
import BalancesPage from '../app/(app)/leave/employee-balances/page';
import RecordsPage from '../app/(app)/leave/employee-records/page';

// Resolve async server children before mounting the page in the client-only test renderer.
async function settle(node:ReactNode):Promise<ReactNode>{
  if(Array.isArray(node))return Promise.all(node.map(settle));
  if(!isValidElement(node))return node;
  const element=node as ReactElement<{children?:ReactNode}>;
  if(typeof element.type==='function'&&element.type.constructor.name==='AsyncFunction')
    return settle(await (element.type as (props:unknown)=>Promise<ReactNode>)(element.props));
  return element.props.children===undefined?element:cloneElement(element,{children:await settle(element.props.children)});
}

const copy={
  en:{balances:'Leave balances by employee and leave type, as at the date you choose.',hint:'View all employees, or search by name or employee ID to select one.'},
  ms:{balances:'Baki cuti mengikut pekerja dan jenis cuti, pada tarikh yang anda pilih.',hint:'Lihat semua pekerja, atau cari mengikut nama atau ID pekerja untuk memilih seorang pekerja.'},
  zh:{balances:'按所选日期查看员工各类假期的余额。',hint:'查看所有员工，或按姓名、员工编号搜索并选择一位员工。'},
  ta:{balances:'நீங்கள் தேர்ந்தெடுக்கும் தேதியின்படி, ஊழியர் மற்றும் விடுப்பு வகை வாரியான விடுப்பு இருப்புகள்.',hint:'அனைத்து ஊழியர்களின் விடுப்பையும் பாருங்கள், அல்லது பெயர் அல்லது பணியாளர் ID மூலம் தேடி ஒருவரைத் தேர்ந்தெடுக்கவும்.'},
  th:{balances:'ยอดวันลาตามพนักงานและประเภทการลา ณ วันที่ที่คุณเลือก',hint:'ดูพนักงานทั้งหมด หรือค้นหาด้วยชื่อหรือรหัสพนักงานเพื่อเลือกพนักงานหนึ่งคน'},
  vi:{balances:'Số dư phép theo nhân viên và loại phép, tính đến ngày bạn chọn.',hint:'Xem tất cả nhân viên, hoặc tìm theo tên hay mã nhân viên để chọn một người.'},
};
const emptyBalances={
  en:'No leave types match this selection.',
  ms:'Tiada jenis cuti yang sepadan dengan pilihan ini.',
  zh:'没有符合当前选择的假期类型。',
  ta:'இந்தத் தேர்விற்குப் பொருந்தும் விடுப்பு வகைகள் இல்லை.',
  th:'ไม่มีประเภทการลาที่ตรงกับการเลือกนี้',
  vi:'Không có loại phép nào phù hợp với lựa chọn này.',
};

it('does not read history for an employee query outside the authorized selected context',async()=>{
  catalog.locale='en';catalog.messages=en;historyReads.mockClear();
  await BalancesPage({searchParams:Promise.resolve({emp:'33333333-3333-4333-8333-333333333333'})});
  expect(historyReads).not.toHaveBeenCalled();
});

for(const [locale,messages] of [['en',en],['ms',ms],['zh',zh],['ta',ta],['th',th],['vi',viMessages]] as const){
  for(const [tab,Page] of [['balances',BalancesPage],['records',RecordsPage]] as const){
    for(const selection of ['all','single'] as const){
      it(`${locale}: ${tab} ${selection} renders scope-accurate guidance with the real employee picker`,async()=>{
        catalog.locale=locale;catalog.messages=messages as typeof en;
        historyReads.mockClear();
        const params=selection==='single'?{emp:people[0].employmentId}:{};
        render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}>{await settle(await Page({searchParams:Promise.resolve(params)}))}</NextIntlClientProvider>);
        if(tab==='balances'&&selection==='single'){
          expect(historyReads).toHaveBeenCalledExactlyOnceWith({},people[0].employmentId);
          expect(screen.getByText(messages.people.detail.recalcHistoryEmpty)).toBeVisible();
        }else expect(historyReads).not.toHaveBeenCalled();
        expect(screen.getByRole('heading',{level:1,name:messages.leave.inquiry[tab==='balances'?'balancesTitle':'recordsTitle']})).toBeVisible();
        expect(screen.getByText(tab==='balances'?copy[locale].balances:messages.leave.inquiry.recordsDescription)).toBeVisible();
        expect(screen.getByText(copy[locale].hint)).toBeVisible();
        const all=screen.getByText(messages.employeePanel.allEmployees).closest('button');
        expect(all).not.toBeNull();
        if(selection==='all'){
          expect(all).toHaveAttribute('aria-current','true');
          const t=createTranslator({locale,messages,namespace:'leave.inquiry'});
          expect(screen.getByText(t('allEmployeesHeader',{count:people.length,companies:'Inquiry Company'}))).toBeVisible();
        }else{
          expect(all).not.toHaveAttribute('aria-current');
          expect(screen.getAllByText(people[0].employeeCode).length).toBeGreaterThan(0);
        }
      });
    }
  }
  for(const selection of ['all','single'] as const){
    for(const search of ['', 'NO-SUCH-FICTIONAL-LEAVE']){
      it(`${locale}: empty balances use scope-neutral copy for ${selection}, ${search?'unmatched search':'no eligible rows'}`,async()=>{
        catalog.locale=locale;catalog.messages=messages as typeof en;
        const params={...(selection==='single'?{emp:people[0].employmentId}:{}),...(search?{q:search}:{})};
        render(<NextIntlClientProvider locale={locale} messages={messages} onError={error=>{throw error;}}>{await settle(await BalancesPage({searchParams:Promise.resolve(params)}))}</NextIntlClientProvider>);
        expect(screen.getByRole('cell',{name:emptyBalances[locale]})).toBeVisible();
        expect(screen.getByPlaceholderText(messages.leave.inquiry.searchPlaceholder)).toHaveValue(search);
        const all=screen.getByText(messages.employeePanel.allEmployees).closest('button');
        expect(all).not.toBeNull();
        if(selection==='all')expect(all).toHaveAttribute('aria-current','true');
        else expect(all).not.toHaveAttribute('aria-current');
      });
    }
  }
}
