// Lane K: the /lifecycle/probation/access page (prototype AccessSection). The permission families render with the
// role's ticks and the scope of each member; a viewer the database refuses gets no editor at all. Fictional data.
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import en from '../messages/en.json';
import type {ProbationAccessView} from '../core/probation-access';

const mocks=vi.hoisted(()=>({session:{tenantId:'t',userId:'u'},view:null as unknown,guard:vi.fn(),access:vi.fn(),search:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as 'probationAccess'})}));
vi.mock('../lib/scoped-lifecycle-page',()=>({requireScopedLifecycleModule:async()=>{mocks.guard();return mocks.session;}}));
vi.mock('../packs/probation/service',()=>({
 PROBATION_CASE_PERMISSIONS:['cases.view','cases.letters','cases.low_result','cases.route'],
 PROBATION_SETTINGS_PERMISSIONS:['settings.configure','settings.intake','settings.postings'],
 probationAccessView:async(ctx:unknown)=>{mocks.access(ctx);return mocks.view;},
 searchProbationAccessPeople:async(ctx:unknown,query:string)=>{mocks.search(ctx,query);return [];},
}));
vi.mock('../app/lifecycle/probation/access/actions',()=>({saveSuperiorRuleAction:vi.fn(),saveRoleAction:vi.fn(),retireRoleAction:vi.fn(),addMemberAction:vi.fn(),changeMemberAction:vi.fn(),revokeMemberAction:vi.fn()}));
vi.mock('../app/lifecycle/probation/access/access.css',()=>({}));
vi.mock('next/link',()=>({__esModule:true,
 // eslint-disable-next-line @typescript-eslint/no-explicit-any
 default:({href,children,prefetch:_prefetch,...rest}:any)=><a href={typeof href==='string'?href:String(href)} {...rest}>{children}</a>}));
import Page from '../app/lifecycle/probation/access/page';

afterEach(()=>{cleanup();vi.clearAllMocks();mocks.view=null;});
const t=en.probationAccess;
const view:ProbationAccessView={
 rule:{enabled:true,view:true,recordDeclined:false,revision:3},
 roles:[{id:'00000000-0000-4000-8000-0000000000a1',name:'People Business Partner',permissions:['cases.view','cases.letters','settings.postings'],revision:2,members:[
  {id:'00000000-0000-4000-8000-0000000000b1',userId:'00000000-0000-4000-8000-0000000000c1',name:'Fictional Partner',businessGroupId:'00000000-0000-4000-8000-0000000000d1',companyId:null,validFrom:'2026-01-01',validTo:null},
 ]}],
 earlier:[{role:'gbs',name:'Fictional People Ops',companyId:'00000000-0000-4000-8000-0000000000d1',validFrom:'2026-01-01',validTo:null}],
 companies:[{id:'00000000-0000-4000-8000-0000000000d1',name:'Fictional Group Sdn Bhd',businessGroupId:'00000000-0000-4000-8000-0000000000d1'}],
 businessGroups:[{id:'00000000-0000-4000-8000-0000000000d1',name:'Fictional Group Sdn Bhd'}],
};

describe('Probation access page',()=>{
 it('renders both permission families with the role\'s ticks, the Direct Superiors rule and each member\'s scope',async()=>{
  mocks.view=view;
  render(await Page({searchParams:Promise.resolve({})}));
  expect(mocks.guard).toHaveBeenCalled();expect(mocks.access).toHaveBeenCalledWith(mocks.session);
  expect(screen.getByRole('heading',{name:t.title})).toBeInTheDocument();
  const cases=screen.getByRole('group',{name:t.roles.cases}),settings=screen.getByRole('group',{name:t.roles.settings});
  const ticked=(group:HTMLElement)=>within(group).getAllByRole('checkbox').map(box=>[(box as HTMLInputElement).value,(box as HTMLInputElement).checked]);
  expect(ticked(cases)).toEqual([['cases.view',true],['cases.letters',true],['cases.low_result',false],['cases.route',false]]);
  expect(ticked(settings)).toEqual([['settings.configure',false],['settings.intake',false],['settings.postings',true]]);
  for(const label of [t.permissions.view,t.permissions.letters,t.permissions.lowResult,t.permissions.route])expect(within(cases).getByText(label)).toBeInTheDocument();
  for(const label of [t.permissions.configure,t.permissions.intake,t.permissions.postings])expect(within(settings).getByText(label)).toBeInTheDocument();
  expect(within(settings).getByText(t.roles.postingsNote)).toBeInTheDocument();
  // The Direct Superiors rule, with the two always-on duties shown but not editable.
  expect((screen.getByRole('checkbox',{name:t.superiors.enabled}) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox',{name:t.superiors.declined}) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole('checkbox',{name:`${t.superiors.kpis} ${t.superiors.alwaysOn}`})).toBeDisabled();
  // A member with a business group scope and the earlier assignment, read-only.
  const member=screen.getByText('Fictional Partner').closest('form')!;
  expect((member.querySelector('select[name="businessGroupId"]') as HTMLSelectElement).value).toBe('00000000-0000-4000-8000-0000000000d1');
  expect((member.querySelector('select[name="companyId"]') as HTMLSelectElement).value).toBe('');
  expect(within(member).getByText(t.members.active)).toBeInTheDocument();
  expect(new FormData(member).get('memberId')).toBe('00000000-0000-4000-8000-0000000000b1');
  expect(screen.getByRole('button',{name:t.members.removeLabel.replace('{name}','Fictional Partner').replace('{role}','People Business Partner')})).toBeInTheDocument();
  expect(screen.getByText(t.earlier.title)).toBeInTheDocument();
 });

 it('shows a viewer the database refuses no roles, members or forms',async()=>{
  mocks.view=null;
  render(await Page({searchParams:Promise.resolve({find:'00000000-0000-4000-8000-0000000000a1',q:'Fictional'})}));
  expect(mocks.guard).toHaveBeenCalled();expect(mocks.access).toHaveBeenCalledWith(mocks.session);
  expect(screen.getByRole('alert')).toHaveTextContent(t.forbidden);
  expect(document.querySelector('form')).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();
  // The people search is never asked for someone who may not open the page.
  expect(mocks.search).not.toHaveBeenCalled();
 });
});
