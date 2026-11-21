/** Document-list pagination must never paginate actions on native task cards. */
import {expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {TasksView} from '../app/tasks/tasks-view';
import type {OnboardingTask} from '../packs/lifecycle/service';
import type {LifecycleTaskDocument} from '../lib/lifecycle-task-documents';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../app/lifecycle/onboarding/case-view',()=>({OnboardingCaseView:()=>null}));
vi.mock('../app/lifecycle/onboarding/v31-actions',()=>({changeOnboarding:vi.fn(),loadOnboardingTask:vi.fn(),writeOnboardingNote:vi.fn()}));
function fixture(){
 const tasks:OnboardingTask[]=Array.from({length:61},(_,i)=>({id:'case:checklist:task-'+i,caseId:'case',revision:1,kind:'checklist',title:'Fictional task '+i,joiner:'Fictional joiner',businessGroup:'',joinDate:'2026-11-18',due:'2026-11-18',overdue:false,assigned:true,tagged:false,team:false,taskId:'task-'+i,documentTemplate:'template-'+i,documentAction:'signed',status:'todo'}));
 const cards:LifecycleTaskDocument[]=tasks.map((task,i)=>({caseId:'case',caseNumber:'OB-FICTIONAL',module:'onb',revision:1,taskId:task.taskId!,taskName:task.title,taskStatus:'todo',dueOn:task.due,action:'signed',sourceName:'Fictional checklist',sourceKind:'checklist',documentId:i===60?null:'saved-'+i,documentName:'Fictional document '+i,documentStatus:i===60?null:'sent',state:i===60?'unreleased':'released'}));
 return{tasks,cards};
}
it('keeps actions on every released native card beyond fifty and never opens an unreleased task when the Documents page changes',()=>{
 const {tasks,cards}=fixture();
 const view=render(<NextIntlClientProvider locale="en" messages={messages}><TasksView items={tasks} existing={[]} cardDocuments={cards} documents={{items:cards.slice(0,50),total:61,offset:0,limit:50}}/></NextIntlClientProvider>);
 const taskCard=(index:number)=>document.getElementById('onboarding-'+tasks[index].id)!;
 expect(screen.getAllByRole('link',{name:'Open document'})).toHaveLength(60);
 expect(within(taskCard(59)).getByRole('link',{name:'Open document'})).toHaveAttribute('href','/me/lifecycle?case=case&document=saved-59');
 expect(within(taskCard(60)).queryByRole('link',{name:'Open document'})).not.toBeInTheDocument();expect(within(taskCard(60)).getByText('This document hasn’t been released yet')).toBeVisible();
 view.rerender(<NextIntlClientProvider locale="en" messages={messages}><TasksView items={tasks} existing={[]} cardDocuments={cards} documents={{items:cards.slice(50),total:61,offset:50,limit:50}}/></NextIntlClientProvider>);
 expect(screen.getAllByRole('link',{name:'Open document'})).toHaveLength(60);
 expect(within(taskCard(0)).getByRole('link',{name:'Open document'})).toHaveAttribute('href','/me/lifecycle?case=case&document=saved-0');expect(within(taskCard(59)).getByRole('link',{name:'Open document'})).toHaveAttribute('href','/me/lifecycle?case=case&document=saved-59');
 expect(within(taskCard(60)).queryByRole('link',{name:'Open document'})).not.toBeInTheDocument();
});
it('does not reuse a document-list entry as authority for an unrelated task card',()=>{
 const {tasks,cards}=fixture();render(<NextIntlClientProvider locale="en" messages={messages}><TasksView items={[tasks[0]]} existing={[]} cardDocuments={[]} documents={{items:[cards[0]],total:1,offset:0,limit:50}}/></NextIntlClientProvider>);
 expect(within(document.getElementById('onboarding-'+tasks[0].id)!).queryByRole('link',{name:'Open document'})).not.toBeInTheDocument();
});
