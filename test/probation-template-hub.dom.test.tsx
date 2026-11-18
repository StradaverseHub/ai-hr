import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import {newV9Template} from '../lib/lifecycle-v9-authoring';
const actions=vi.hoisted(()=>({saveV9:vi.fn(),saveEmail:vi.fn().mockResolvedValue({ok:true,result:{revision:1,warnings:[]}})}));
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/v9',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9PersonnelPreview:vi.fn(),readV9WorkflowRemoval:vi.fn(),removeV9Workflow:vi.fn(),restoreV9Workflow:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:actions.saveV9,setupV9:vi.fn()}));
vi.mock('../app/automation/actions',()=>({saveEmailTemplateAction:actions.saveEmail,readEmailTemplateHistoryAction:vi.fn().mockResolvedValue({ok:true,result:[]}),searchPeopleAction:vi.fn()}));
vi.mock('../components/email-body-editor',()=>({EmailBodyEditor:()=>null}));
import {V9Workspace} from '../app/lifecycle/v9/workspace';
import {ProbationTemplateSection} from '../app/automation/templates/probation-template-section';
HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
afterEach(()=>{cleanup();vi.clearAllMocks();});
const actor={id:'fictional-hr',name:'Fictional HR'};
function fixture(routed=false){
 const config=v9Defaults();
 if(routed){const template=newV9Template('Letter',actor,'fictional-letter','2026-11-18T00:00:00Z');template.name='Fictional routed letter';template.versions[0].routing=[{id:'hr',order:1,action:'sign',owner:true,who:{kind:'group',groupId:'people'}},{id:'employee',order:2,action:'acknowledge',owner:false,who:{kind:'employee'}}];template.versions[0].blocks=[{id:'hr-block',type:'signature',text:'',section:'',role:'step:hr',label:'HR'},{id:'employee-block',type:'signature',text:'',section:'',role:'step:employee',label:'Employee'}];config.templates=[template];}
 return render(<NextIntlClientProvider locale="en" messages={messages}><V9Workspace initial={{config,cases:[],actor,canConfigure:true,personnelWritableKeys:[],permissions:{onboarding:true,offboarding:true,administration:true},options:{users:[],companies:[],employees:[],labels:{},leaveTypes:[],documentRoutingChoices:{routings:[],groups:[{id:'people',name:'Fictional People Ops'}],people:[]}}}} viewer={{name:actor.name,employeeCode:null,employed:false}} navigation="global" initialView="templates" probationTemplates={<ProbationTemplateSection emails={[]} refs={{routings:[],groups:[],people:[]}}/>}/></NextIntlClientProvider>);
}
it('offers Probation from the common New email control and keeps its draft outside V9 configuration',async()=>{
 fixture();
 const tabs=screen.getByRole('tablist',{name:'Module'});expect(within(tabs).getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['All modules','Onboarding','Offboarding','Probation']);
 const shared=screen.getByRole('region',{name:'Email templates'});fireEvent.click(within(shared).getByRole('button',{name:'New email'}));fireEvent.click(screen.getByRole('menuitem',{name:'Probation'}));
 expect(await screen.findByRole('dialog',{name:'Edit Probation email'})).toBeInTheDocument();expect(screen.getByRole('combobox',{name:'Module'})).toHaveValue('probation');expect(actions.saveV9).not.toHaveBeenCalled();
});
it('edits native Sign and Acknowledge block links without the duplicate legacy HR signature setting',async()=>{
 fixture(true);fireEvent.click(screen.getByRole('button',{name:'Edit Fictional routed letter'}));
 await waitFor(()=>expect(screen.getByRole('heading',{name:'Signing and review routing'})).toBeInTheDocument());
 expect(screen.queryByRole('combobox',{name:'HR signature'})).toBeNull();expect(screen.getByRole('combobox',{name:'Signer 1'})).toHaveValue('step:hr');expect(screen.getByRole('combobox',{name:'Signer 2'})).toHaveValue('step:employee');
});

it('shows company letter configuration without global email authoring controls',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><ProbationTemplateSection canEditEmails={false} emails={[]} refs={{routings:[],groups:[],people:[]}} letters={<h2>Fictional company letter configuration</h2>}/></NextIntlClientProvider>);
 expect(screen.getByRole('heading',{name:'Fictional company letter configuration'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'New email'})).toBeNull();expect(screen.queryByRole('region',{name:'Email templates · Probation'})).toBeNull();
});
