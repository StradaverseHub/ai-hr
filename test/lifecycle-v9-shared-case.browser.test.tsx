import {page} from 'vitest/browser';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/onboarding-workspace.css';
import '../app/lifecycle/v9/workspace.css';
import {beforeAll,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {blankCase,defaultConfig} from '../lib/onboarding-model';
import {OnboardingCaseView} from '../app/lifecycle/onboarding/case-view';
import {NativeCaseDocuments} from '../app/lifecycle/v9/native-case-documents';
import {communicationsFixture} from './helpers/communications-fixture';
import {defaultV9CaseFields} from '../lib/lifecycle-v9-case-form';
import {fictionalV9Case,fictionalV9Task} from './fixtures/lifecycle-v9/case';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {OffboardingCaseView,caseTasksByDue} from '../app/lifecycle/v9/offboarding-case-view';
vi.mock('../app/lifecycle/onboarding/v31-actions',()=>({changeOnboarding:vi.fn(),writeOnboardingNote:vi.fn(),markOnboardingSeen:vi.fn().mockResolvedValue(undefined),searchOnboardingTaUsers:vi.fn().mockResolvedValue({users:[],error:null})}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9PersonnelPreview:vi.fn().mockResolvedValue({ok:true,values:{}}),commandV9:vi.fn(),readV9Case:vi.fn().mockResolvedValue({ok:false,error:'Salary source unavailable'}),readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn()}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};});
function fixture(state:'submitted'|'cleared'|'cancelled'|'pending'='submitted'){
 const communications=communicationsFixture('off');
 const c=fictionalV9Case({...communications.c,state,tasks:[{...fictionalV9Task('Later task'),dueOn:'2026-12-02'},{...fictionalV9Task('Document task'),documentTemplate:'document',dueOn:'2026-11-28'},fictionalV9Task('Earlier task')],items:[{id:'item',name:'Fictional laptop',kind:'device',sourceId:null,group:null,assignee:null,dueOn:'2026-11-30',status:'todo',reason:'',returnReported:{at:'2026-11-01T00:00:00Z',by:'employee',note:'Reception receipt'},nativeSource:{caseId:'native-case',requestId:'request',itemId:'native-item',requestNumber:'IT-FICTIONAL'}}]});
 const command=vi.fn().mockResolvedValue({ok:false,error:'Refresh your case.'}),onReason=vi.fn(),onDocument=vi.fn();
 const view=render(<NextIntlClientProvider locale="en" messages={messages}><div className="v9-workspace v9-workspace-global"><OffboardingCaseView c={c} config={communications.config} users={[]} actor={{id:'hr',name:'Fictional HR'}} personnelWritableKeys={['mobile']} busy={false} command={command} onDocument={onDocument} onReason={onReason} onOpenWorkflow={vi.fn()} onBack={vi.fn()} today="2026-11-02"/></div></NextIntlClientProvider>);
 return {c,command,onReason,onDocument,...view};
}
it.each([1440,390])('renders the approved shared case structure at %i pixels without page overflow',async width=>{
 await page.viewport(width,1000);
 const {container,command,onDocument}=fixture();
 await screen.findByText('Salary source unavailable');
 const workspace=container.querySelector('.lifecycle-case-page') as HTMLElement;
 expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth+1);
 // Return/revoke and exit clearance stay outside the approved tabbed communications region.
 // Assert its populated replacement surfaces independently rather than restoring the obsolete six-section layout.
 const headings=[...container.querySelectorAll('.lifecycle-case-page>.lifecycle-case-section')].map(section=>section.querySelector('h2')?.textContent);
 expect(headings).toEqual(['Return and revoke','Exit clearance']);
 const communications=screen.getByRole('region',{name:'Communications & documents'});
 const tabs=within(communications).getAllByRole('tab');
 expect(tabs.map(tab=>tab.textContent?.replace(/\s+\d+$/, '').trim())).toEqual(['Schedule','Documents & files','Sent log','Personnel changes']);
 const assertWidth=()=>expect(workspace.scrollWidth).toBeLessThanOrEqual(workspace.clientWidth+1);
 for(const [index,label] of ['Schedule','Documents & files','Sent log','Personnel changes'].entries()){
  const tab=tabs[index];fireEvent.click(tab);
  expect(tab).toHaveAttribute('aria-selected','true');
  const panelId=tab.getAttribute('aria-controls');if(!panelId)throw Error('Tab must identify its panel');
  const panel=document.getElementById(panelId);if(!panel)throw Error('Tab panel missing');
  expect(panel).toBeVisible();
  for(const other of tabs.filter(candidate=>candidate!==tab)){
   expect(other).toHaveAttribute('aria-selected','false');
   const otherId=other.getAttribute('aria-controls');if(!otherId)throw Error('Tab must identify its panel');
   expect(document.getElementById(otherId)).not.toBeVisible();
  }
  if(label==='Schedule'){
   expect(within(panel).getAllByText('Fictional welcome email').length).toBeGreaterThan(0);
   expect(within(panel).getByText('Fictional unscheduled email')).toBeVisible();
   expect(within(panel).getByRole('heading',{name:'Unscheduled email templates'})).toBeVisible();
   expect(within(panel).getByRole('checkbox',{name:'Show test sends (1)'})).not.toBeChecked();
  }else if(label==='Documents & files'){
   expect(within(panel).getByRole('button',{name:'Open Fictional acceptance letter'})).toBeVisible();
   expect(within(panel).getByRole('link',{name:'Fictional evidence.pdf'})).toHaveAttribute('href',expect.stringContaining('file=file'));
   expect(within(panel).queryByRole('button',{name:'Upload file'})).not.toBeInTheDocument();
  }else if(label==='Sent log'){
   const deliveries=within(panel).getByRole('list',{name:'Email delivery history'});
   expect([...deliveries.children].map(row=>row.id)).toEqual(['delivery-test-mail','delivery-receipt']);
   expect(within(deliveries).getByText('Test send')).toBeVisible();
  }else{
   expect(within(panel).getByRole('checkbox',{name:'Push mobile to Personnel Management'})).toBeVisible();
   expect(within(panel).getByText('0222222222')).toBeVisible();
  }
  assertWidth();
  await page.screenshot({path:`../.vitest-attachments/approved-offboarding-communications-${index}-${width}.png`,animations:'disabled',scale:'css'});
 }
 // Merely navigating existing information does not run a workflow, open a document or write Personnel.
 expect(command).not.toHaveBeenCalled();expect(onDocument).not.toHaveBeenCalled();
 fireEvent.click(tabs[0]);
 const aside=container.querySelector('.onb-aside') as HTMLElement;
 const main=container.querySelector('.onb-main') as HTMLElement;
 expect(aside).not.toBeNull();
 if(width>1000)expect(aside.getBoundingClientRect().left).toBeGreaterThan(main.getBoundingClientRect().right);
 else expect(aside.getBoundingClientRect().top).toBeGreaterThan(main.getBoundingClientRect().top);
 const offHeader=getComputedStyle(container.querySelector('.lifecycle-case-header h1')!).fontSize;
 const offColumnWidth=main.getBoundingClientRect().width;
 await page.screenshot({path:`../.vitest-attachments/approved-offboarding-case-${width}.png`,animations:'disabled',scale:'css'});
 cleanup();
 const today='2026-11-02',env={today,now:today+'T02:00:00Z',id:()=> 'fictional-history',nextNumber:()=>'',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['owner']};
 const c=blankCase('native-case','OB-FICTIONAL','draft',{fullName:'Fictional Joiner',joinDate:'2026-11-30'},env);
 const config=defaultConfig('owner');config.v9ChecklistRevision=1;config.v9CaseFields=defaultV9CaseFields('onb');
 const detail={case:c,config,revision:1,actor:{id:'owner',name:'Fictional HR',module:true,hr:true,master:false},directory:[],labels:{},notes:[],availability:{},today,canOpenRequisition:false};
 const onboard=render(<NextIntlClientProvider locale="en" messages={messages}><div className="v9-workspace v9-workspace-global"><OnboardingCaseView detail={detail} registerHref="/lifecycle/v9"/><NativeCaseDocuments initial={fictionalV9Case({id:c.id,module:'onb',facts:{...fictionalV9Case().facts,name:'Fictional Joiner',joinDate:'2026-11-30',company:'company',title:'position',department:'department',supervisorUserId:'owner'}})} config={v9Defaults()} actor={{id:'owner',name:'Fictional HR'}} writableKeys={[]}/></div></NextIntlClientProvider>);
 expect(getComputedStyle(onboard.container.querySelector('.lifecycle-case-header h1')!).fontSize).toBe(offHeader);
 expect(Math.abs(onboard.container.querySelector('.onb-main')!.getBoundingClientRect().width-offColumnWidth)).toBeLessThan(2);
 expect(onboard.container.querySelector('.onb-aside>.lifecycle-case-section')).not.toBeNull();
 await page.screenshot({path:`../.vitest-attachments/approved-onboarding-case-${width}.png`,animations:'disabled',scale:'css'});
});
