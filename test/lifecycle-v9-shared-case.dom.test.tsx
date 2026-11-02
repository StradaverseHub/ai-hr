import {beforeAll,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {fictionalV9Case,fictionalV9Task} from './fixtures/lifecycle-v9/case';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {OffboardingCaseView,caseTasksByDue} from '../app/lifecycle/v9/offboarding-case-view';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Case:vi.fn().mockResolvedValue({ok:false,error:'Salary source unavailable'}),readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn()}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};});
function fixture(state:'submitted'|'cleared'|'cancelled'|'pending'='submitted'){
 const c=fictionalV9Case({state,tasks:[{...fictionalV9Task('Later task'),dueOn:'2026-12-02'},{...fictionalV9Task('Document task'),documentTemplate:'document',dueOn:'2026-11-28'},fictionalV9Task('Earlier task')],items:[{id:'item',name:'Fictional laptop',kind:'device',sourceId:null,group:null,assignee:null,dueOn:'2026-11-30',status:'todo',reason:'',returnReported:{at:'2026-11-01T00:00:00Z',by:'employee',note:'Reception receipt'},nativeSource:{caseId:'native-case',requestId:'request',itemId:'native-item',requestNumber:'IT-FICTIONAL'}}]});
 const command=vi.fn().mockResolvedValue({ok:false,error:'Refresh your case.'}),onReason=vi.fn();
 const view=render(<NextIntlClientProvider locale="en" messages={messages}><OffboardingCaseView c={c} config={v9Defaults()} users={[]} actor={{id:'hr',name:'Fictional HR'}} personnelWritableKeys={[]} busy={false} command={command} onDocument={vi.fn()} onReason={onReason} onOpenWorkflow={vi.fn()} onBack={vi.fn()} today="2026-11-02"/></NextIntlClientProvider>);
 return {c,command,onReason,...view};
}
it('sorts only the visible tasks and preserves document completion, return provenance and rejected actions',async()=>{
 const {c,command,onReason,container}=fixture();
 const source=JSON.stringify(c);
 expect([...container.querySelectorAll('.lifecycle-case-task h3')].map(node=>node.textContent)).toEqual(['Document task','Earlier task','Later task']);
 expect(screen.getByRole('checkbox',{name:'Mark task done Document task'})).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox',{name:'Mark task done Earlier task'}));
 expect(command).toHaveBeenCalledWith({type:'task',id:'Earlier task',status:'done',reason:''});
 expect(await screen.findByText('Refresh your case.')).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Cancel offboarding case'}));expect(onReason).toHaveBeenCalledWith('cancel');
 fireEvent.click(screen.getByRole('button',{name:'Edit details'}));expect(screen.getByRole('textbox',{name:'Reason for changing case details'})).toBeVisible();
 const table=within(screen.getByRole('table',{name:'Return and revoke'}));
 expect(table.getByRole('link',{name:/IT-FICTIONAL/})).toHaveAttribute('href','/lifecycle/requisitions/onboarding/native-case');
 expect(table.getByText(/Reception receipt/)).toHaveTextContent('Waiting for the providing team to confirm.');
 expect(screen.getByRole('heading',{name:'Sent emails'}).closest('section')).toHaveClass('lifecycle-case-section');
 expect(screen.getByRole('heading',{name:'Notes'}).compareDocumentPosition(screen.getByRole('heading',{name:'Leaver calculator'}))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(JSON.stringify(c)).toBe(source);
});
it.each(['cleared','cancelled'] as const)('keeps %s work read-only and only exposes the existing reopen action for clearance',state=>{
 const {onReason}=fixture(state);
 expect(screen.getByRole('checkbox',{name:'Mark task done Earlier task'})).toBeDisabled();
 expect(screen.queryByRole('button',{name:'Edit details'})).not.toBeInTheDocument();
 if(state==='cleared'){fireEvent.click(screen.getByRole('button',{name:'Reopen case'}));expect(onReason).toHaveBeenCalledWith('reopen');}else expect(screen.queryByRole('button',{name:'Reopen case'})).not.toBeInTheDocument();
});
it('keeps stable ties and unknown dates last without mutating the stored task order',()=>{
 const tasks=[{id:'undated',dueOn:''},{id:'a',dueOn:'2026-11-01'},{id:'b',dueOn:'2026-11-01'}];
 expect(caseTasksByDue(tasks).map(task=>task.id)).toEqual(['a','b','undated']);expect(tasks.map(task=>task.id)).toEqual(['undated','a','b']);
});
