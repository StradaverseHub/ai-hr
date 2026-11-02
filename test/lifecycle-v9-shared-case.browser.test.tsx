import {page} from 'vitest/browser';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/onboarding-workspace.css';
import '../app/lifecycle/v9/workspace.css';
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
it.each([1440,390])('renders the approved shared case structure at %i pixels without page overflow',async width=>{
 await page.viewport(width,1000);
 const {container}=fixture();
 await screen.findByText('Salary source unavailable');
 const workspace=container.querySelector('.lifecycle-case-page') as HTMLElement;
 expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth+1);
 const headings=[...container.querySelectorAll('.lifecycle-case-page>.lifecycle-case-section>h2')].map(node=>node.textContent);
 expect(headings).toEqual(['Return and revoke','Documents','Case files','Workflows','Emails for this person','Sent emails','Exit clearance']);
 const aside=container.querySelector('.onb-aside') as HTMLElement;
 const main=container.querySelector('.onb-main') as HTMLElement;
 expect(aside).not.toBeNull();
 if(width>1000)expect(aside.getBoundingClientRect().left).toBeGreaterThan(main.getBoundingClientRect().right);
 else expect(aside.getBoundingClientRect().top).toBeGreaterThan(main.getBoundingClientRect().top);
 await page.screenshot({path:`../.vitest-attachments/approved-offboarding-case-${width}.png`,animations:'disabled',scale:'css'});
});
