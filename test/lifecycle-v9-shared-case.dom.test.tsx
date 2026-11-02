import {beforeAll,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {readFileSync} from 'node:fs';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
import {blankCase,defaultConfig,submitCase} from '../lib/onboarding-model';
import {OnboardingCaseView} from '../app/lifecycle/onboarding/case-view';
import {NativeCaseDocuments} from '../app/lifecycle/v9/native-case-documents';
import {fictionalV9Case,fictionalV9Task} from './fixtures/lifecycle-v9/case';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {OffboardingCaseView,caseTasksByDue} from '../app/lifecycle/v9/offboarding-case-view';
vi.mock('../app/lifecycle/onboarding/v31-actions',()=>({changeOnboarding:vi.fn(),writeOnboardingNote:vi.fn(),markOnboardingSeen:vi.fn().mockResolvedValue(undefined)}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/lifecycle/v9/actions',()=>({commandV9:vi.fn(),readV9Case:vi.fn().mockResolvedValue({ok:false,error:'Salary source unavailable'}),readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn()}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};});
function fixture(state:'submitted'|'cleared'|'cancelled'|'pending'='submitted',locale='en'){
 const c=fictionalV9Case({state,tasks:[{...fictionalV9Task('Later task'),assignee:'recorded-owner',dueOn:'2026-12-02'},{...fictionalV9Task('Document task'),documentTemplate:'document',dueOn:'2026-11-28'},fictionalV9Task('Earlier task')],items:[{id:'item',name:'Fictional laptop',kind:'device',sourceId:null,group:null,assignee:null,dueOn:'2026-11-30',status:'todo',reason:'',returnReported:{at:'2026-11-01T00:00:00Z',by:'employee',note:'Reception receipt'},nativeSource:{caseId:'native-case',requestId:'request',itemId:'native-item',requestNumber:'IT-FICTIONAL'}}]});
 const command=vi.fn().mockResolvedValue({ok:false,error:'Refresh your case.'}),onReason=vi.fn();
 const view=render(<NextIntlClientProvider locale={locale} messages={locale==='en'?messages:JSON.parse(readFileSync(`messages/${locale}.json`,'utf8'))}><div className="v9-workspace v9-workspace-global"><OffboardingCaseView c={c} config={v9Defaults()} users={[{id:'recorded-owner',name:'Recorded owner'}]} actor={{id:'hr',name:'Fictional HR'}} personnelWritableKeys={[]} busy={false} command={command} onDocument={vi.fn()} onReason={onReason} onOpenWorkflow={vi.fn()} onBack={vi.fn()} today="2026-11-02"/></div></NextIntlClientProvider>);
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
 const row=screen.getByRole('heading',{name:'Later task'}).closest('.lifecycle-case-task')!;expect(within(row as HTMLElement).getByText('Recorded owner')).toBeVisible();
 if(state==='cleared'){fireEvent.click(screen.getByRole('button',{name:'Reopen case'}));expect(onReason).toHaveBeenCalledWith('reopen');}else expect(screen.queryByRole('button',{name:'Reopen case'})).not.toBeInTheDocument();
});
it('keeps stable ties and unknown dates last without mutating the stored task order',()=>{
 const tasks=[{id:'undated',dueOn:''},{id:'a',dueOn:'2026-11-01'},{id:'b',dueOn:'2026-11-01'}];
 expect(caseTasksByDue(tasks).map(task=>task.id)).toEqual(['a','b','undated']);expect(tasks.map(task=>task.id)).toEqual(['undated','a','b']);
});

it.each(['en','ms','zh','ta','th','vi'])('captures paired real case adapters in %s on the hosted runner',async locale=>{
 const off=fixture('submitted',locale);await screen.findByText('Salary source unavailable');
 await captureAiReviewScreenshots(aiReviewDomHtml(off.container),locale,'lifecycle-case-offboarding');cleanup();
 const today='2026-11-02';let next=0;
 const env={today,now:today+'T02:00:00Z',id:()=> 'fictional-history-'+(++next),nextNumber:()=> 'IT-FICTIONAL-'+(++next),leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:['owner']};
 const config=defaultConfig('owner'),actor={id:'owner',name:'Fictional HR',module:true,hr:true,master:false};
 config.checklists[0].tasks=[{id:'welcome',name:'Fictional welcome task',by:'group',group:'people-gbs',method:'manual',opens:null,due:1,gate:false}];
 const c=blankCase('native-case','OB-FICTIONAL','draft',{fullName:'Fictional Joiner',joinDate:'2026-11-30',title:'position',company:'company',department:'department',supervisor:'owner'},env);c.hiring='new_hire';submitCase(config,c,actor,env);config.v9ChecklistRevision=1;
 const detail={case:c,config,revision:1,actor,directory:[{id:'owner',name:'Fictional HR'}],labels:{title:'Fictional Analyst',company:'Fictional Company',department:'Fictional Department'},notes:[],availability:{},today,canOpenRequisition:true};
 const onboard=render(<NextIntlClientProvider locale={locale} messages={locale==='en'?messages:JSON.parse(readFileSync(`messages/${locale}.json`,'utf8'))}><div className="v9-workspace v9-workspace-global"><OnboardingCaseView detail={detail} registerHref="/lifecycle/v9"/><NativeCaseDocuments initial={fictionalV9Case({id:c.id,module:'onb',facts:{...fictionalV9Case().facts,name:'Fictional Joiner',joinDate:'2026-11-30',company:'company',title:'position',department:'department',supervisorUserId:'owner'}})} config={v9Defaults()} actor={{id:'owner',name:'Fictional HR'}} writableKeys={[]}/></div></NextIntlClientProvider>);
 expect(onboard.container.querySelectorAll('.lifecycle-case-header')).toHaveLength(1);
 expect(onboard.container.querySelectorAll('.lifecycle-case-task')).toHaveLength(1);
 await captureAiReviewScreenshots(aiReviewDomHtml(onboard.container),locale,'lifecycle-case-onboarding');
},120_000);

it('ends shared detail editing when the mounted case becomes closed',()=>{
 const c=fictionalV9Case(),props={config:v9Defaults(),users:[],actor:{id:'owner',name:'Fictional HR'},personnelWritableKeys:[],busy:false,command:vi.fn().mockResolvedValue({ok:true}),onDocument:vi.fn(),onReason:vi.fn(),onOpenWorkflow:vi.fn(),onBack:vi.fn(),today:'2026-11-02'};
 const view=render(<NextIntlClientProvider locale="en" messages={messages}><OffboardingCaseView c={c} {...props}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Edit details'}));expect(screen.getByRole('combobox',{name:'Case type *'})).toBeEnabled();
 view.rerender(<NextIntlClientProvider locale="en" messages={messages}><OffboardingCaseView c={{...c,state:'cancelled',revision:2}} {...props}/></NextIntlClientProvider>);
 expect(screen.getByRole('combobox',{name:'Case type *'})).toBeDisabled();expect(screen.queryByRole('textbox',{name:'Reason for changing case details'})).not.toBeInTheDocument();
});
