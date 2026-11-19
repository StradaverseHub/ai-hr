import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viCopy from '../messages/vi.json';
import type {PersonnelPosting} from '../packs/personnel-postings/service';
const state=vi.hoisted(()=>({locale:'en' as 'en'|'ms'|'zh'|'ta'|'th'|'vi',rows:[] as PersonnelPosting[],waiting:{} as Record<string,{names:string[];total:number}>}));
const copies={en,ms,zh,ta,th,vi:viCopy};
vi.mock('next-intl/server',()=>({getTranslations:async(namespace: 'offboardingPostings'|'personnelPostings')=>createTranslator({locale:state.locale,messages:copies[state.locale],namespace,onError:error=>{throw error;}})}));
vi.mock('../lib/scoped-lifecycle-page',()=>({requireScopedLifecycleModule:async()=>({tenantId:'fictional-tenant',userId:'fictional-viewer'})}));
const reads=vi.hoisted(()=>({list:vi.fn(),names:vi.fn()}));
vi.mock('../packs/personnel-postings/service',()=>({listPersonnelPostings:reads.list,loadOffboardingPostingApprovers:reads.names}));
vi.mock('../app/lifecycle/offboarding/postings/actions',()=>({approveOffboardingPostingAction:vi.fn(),rejectOffboardingPostingAction:vi.fn(),retryOffboardingPostingAction:vi.fn()}));
vi.mock('next/link',()=>({default:({href,children,...rest}:{href:string;children:import('react').ReactNode})=><a href={href} {...rest}>{children}</a>}));
import Page from '../app/lifecycle/offboarding/postings/page';
const row=(over:Partial<PersonnelPosting>={}):PersonnelPosting=>({id:'00000000-0000-4000-8000-000000001043',number:1043,label:'PP-1043',employmentId:'fictional-employment',companyId:'fictional-company',employeeName:'Fictional employee',employeeCode:'F-43',source:'offboarding',sourceRef:'fictional-resignation',eventType:'promotion',proposed:{effectiveDate:'2026-11-17',basicSalary:'5500'},edited:null,applied:null,current:{effectiveDate:'2026-11-17',basicSalary:'5500'},baseline:{basicSalary:'5000',currency:'SGD'},editedBy:null,editedAt:null,approverGroupId:'fictional-group',approverGroupName:'Configured People Ops',status:'pending',displayStatus:'pending',approvedBy:null,approvedAt:null,movementId:null,createdAt:'2026-11-17T00:00:00Z',revision:1,dueOn:null,rejectionReason:null,canRetry:false,canApprove:false,canEdit:false,...over});
beforeEach(()=>{state.locale='en';state.rows=[row()];state.waiting={[state.rows[0].id]:{names:['Fictional Aina','Fictional Bala','Fictional Chen'],total:5}};reads.list.mockImplementation(async()=>({rows:state.rows,offset:0,limit:50,hasMore:false}));reads.names.mockImplementation(async()=>state.waiting);});
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('shows named waiting people, bounded remainder and total to a nonapprover, with formatted frozen-currency pay',async()=>{
 render(await Page({searchParams:Promise.resolve({})}));const entry=within(screen.getByRole('row',{name:/PP-1043/}));
 expect(entry.getByText('Waiting for Fictional Aina, Fictional Bala, Fictional Chen · 2 others')).toBeInTheDocument();expect(entry.getByText('5 total')).toBeInTheDocument();
 expect(entry.getByText('Basic salary: SGD 5,000.00 → SGD 5,500.00')).toBeInTheDocument();expect(entry.queryByRole('button',{name:'Approve'})).toBeNull();expect(entry.queryByRole('link',{name:'Edit'})).toBeNull();expect(entry.queryByText('Reject')).toBeNull();
 expect(reads.names).toHaveBeenCalledExactlyOnceWith(expect.any(Object),[state.rows[0].id]);
});
it('does not invent a currency or identity when the legacy source or current group has no known names',async()=>{
 state.rows=[row({baseline:{basicSalary:'0',currency:null},current:{effectiveDate:'2026-11-17',basicSalary:'12500'}})];state.waiting={[state.rows[0].id]:{names:[],total:0}};
 render(await Page({searchParams:Promise.resolve({})}));const entry=within(screen.getByRole('row',{name:/PP-1043/}));
 expect(entry.getByText('Basic salary: 0.00 → 12,500.00')).toBeInTheDocument();expect(entry.getByText('Waiting for Configured People Ops')).toBeInTheDocument();expect(entry.getByText('0 total')).toBeInTheDocument();expect(entry.queryByText(/MYR|RM|SGD/)).toBeNull();
});
it.each(['en','ms','zh','ta','th','vi'] as const)('renders actual names and localized remainder/total in %s without missing copy',async locale=>{
 state.locale=locale;render(await Page({searchParams:Promise.resolve({})}));const t=createTranslator({locale,messages:copies[locale],namespace:'offboardingPostings'});
 expect(screen.getByText(t('waitingTotal',{count:5}))).toBeInTheDocument();expect(screen.getByText(text=>text.includes('Fictional Aina, Fictional Bala, Fictional Chen')&&text.includes(t('waitingOthers',{count:2})))).toBeInTheDocument();
});
