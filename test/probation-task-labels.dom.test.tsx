import {describe,expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi_ from '../messages/vi.json';
import type {PendingTaskItem} from '../core/approvals-inbox';
import {PROBATION_TASK_KINDS,probationTaskLabel} from '../lib/probation-task-labels';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../app/lifecycle/onboarding/v31-actions',()=>({changeOnboarding:vi.fn(),loadOnboardingTask:vi.fn(),writeOnboardingNote:vi.fn(),markOnboardingSeen:vi.fn()}));
const {TasksView}=await import('../app/tasks/tasks-view');
type Translate=(key:string,values?:Record<string,string|number>)=>string;
const translator=(messages:object)=>createTranslator({locale:'en',messages:messages as typeof en,namespace:'probation'}) as unknown as Translate;

describe('Probation task labels by kind (L5)',()=>{
 it('names every step app.probation_task_list can return, in every catalogue, with the part filled in',()=>{
  for(const messages of [en,ms,zh,ta,th,vi_]){
   const t=translator(messages);
   for(const kind of PROBATION_TASK_KINDS)for(const part of [1,2,3]){
    const label=probationTaskLabel(kind,part);
    for(const text of [t(label.title,label.values),t(label.action,label.values)]){expect(text.trim()).not.toBe('');expect(text).not.toMatch(/\{|taskKinds|Probation task$/);}
   }
  }
  const t=translator(en),say=(kind:string,part:number|string|null)=>{const l=probationTaskLabel(kind,part);return[t(l.title,l.values),t(l.action,l.values)];};
  expect(say('letter_sign','3')).toEqual(['Sign probation letter','Sign letter']);
  expect(say('low_result_action','2')).toEqual(['Record low-result action','Record action']);
  expect(say('choose_outcome',null)).toEqual(['Decide Other outcome','Decide outcome']);
  expect(say('submit_manager','1')).toEqual(['Set Week 1 KPIs and sign','Set KPIs']);
  expect(say('submit_manager',3)).toEqual(['Complete the Line Manager assessment and sign · Part 3','Open assessment']);
  expect(say('approve','3')).toEqual(['Approve Part 3','Review and approve']);
  // A kind this screen does not know yet, or a part step without its part, still reads plainly and opens the case.
  expect(say('something_new','2')).toEqual(['Probation task','Open']);expect(say('acknowledge',null)).toEqual(['Probation task','Open']);
 });
 it('labels Probation rows on /tasks by their step instead of "Probation task · Review approval"',()=>{
  const row=(id:string,kind:'probationTask'|'probationApproval',action?:PendingTaskItem['action']):PendingTaskItem=>({id,kind,subjectName:'Fictional '+id,createdAt:'2026-11-16T04:00:00.000Z',linkPath:'/lifecycle/probation/case/'+id,...(action?{action}:{})});
  render(<NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Kuala_Lumpur"><TasksView items={[]} existing={[row('a','probationTask',{code:'letter_sign',part:3}),row('b','probationTask',{code:'low_result_action',part:2}),row('c','probationApproval',{code:'approve',part:3}),row('d','probationTask')]}/></NextIntlClientProvider>);
  expect(screen.getByText('Sign probation letter')).toBeInTheDocument();expect(screen.getByRole('link',{name:'Sign letter'})).toHaveAttribute('href','/lifecycle/probation/case/a');
  expect(screen.getByText('Record low-result action')).toBeInTheDocument();expect(screen.getByRole('link',{name:'Record action'})).toHaveAttribute('href','/lifecycle/probation/case/b');
  expect(screen.getByText('Approve Part 3')).toBeInTheDocument();expect(screen.getByRole('link',{name:'Review and approve'})).toHaveAttribute('href','/lifecycle/probation/case/c');
  // An item without a step code (an older provider) keeps the shared wording.
  expect(screen.getAllByText(en.notifications.task.probationTask)).toHaveLength(1);expect(screen.getByRole('link',{name:'Review approval'})).toHaveAttribute('href','/lifecycle/probation/case/d');
 });
});
