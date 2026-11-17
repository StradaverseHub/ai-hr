import {beforeAll,afterAll,afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen,within,fireEvent} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider,type AbstractIntlMessages} from 'next-intl';
import messages from '../messages/en.json';
import {v9Defaults} from '../lib/lifecycle-v9-defaults';
import type {Template} from '../lib/lifecycle-v9-model';
import type {AutomationWorkflow} from '../lib/automation/workflow';
import {lifecycleTemplateListMetadata} from '../lib/lifecycle-template-list';
vi.mock('next/navigation',()=>({usePathname:()=>'/automation/templates',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../components/user-menu',()=>({UserMenu:()=>null}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9PersonnelPreview:vi.fn(),readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:vi.fn(),setupV9:vi.fn()}));
import {TemplateEditor} from '../app/lifecycle/v9/workspace';
const dialogMethods=['showModal','close'] as const;
const originalDialogMethods=dialogMethods.map(name=>Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype,name));
beforeAll(()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(this:HTMLDialogElement){this.setAttribute('open','');}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(this:HTMLDialogElement){this.removeAttribute('open');}});
});
afterAll(()=>{dialogMethods.forEach((name,index)=>{const original=originalDialogMethods[index];if(original)Object.defineProperty(HTMLDialogElement.prototype,name,original);else Reflect.deleteProperty(HTMLDialogElement.prototype,name);});});
afterEach(cleanup);
// The production metadata adapter accepts dynamic catalogue keys; missing keys still throw below.
const catalogue:AbstractIntlMessages=messages;
const t=createTranslator({locale:'en',messages:catalogue,namespace:'automation',onError:error=>{throw error;}});
const template=(id:string,module:'onb'|'off'='off'):Template=>({id,name:'Acceptance letter',module,type:'Letter',rules:{},hrStep:'none',employeeAck:false,retired:false,currentVersion:1,versions:[{version:1,state:'published',at:'2026-11-17T00:00:00Z',by:'Fictional editor',blocks:[],fields:[],routing:[{id:'employee',order:2,action:'sign',who:{kind:'employee'},owner:false},{id:'review',order:1,action:'review',who:{kind:'group',groupId:'ops'},owner:true},{id:'approve',order:1,action:'approve',who:{kind:'people',userIds:['bp']},owner:false}]}]});
function fixture(){
 const config=v9Defaults();config.templates=[template('shared'),template('legacy'),template('onboarding','onb'),template('unused')];config.groups=[{id:'ops',name:'Fictional People Ops',members:[],limit:5}];
 config.emails=[{id:'mail',module:'off',name:'Acceptance email',active:true,sender:'',subject:'Accepted',body:'',cc:[],links:['shared'],attachments:['shared'],slots:[]}];
 config.workflows=[{id:'legacy-workflow',name:'Existing clearance',module:'off',status:'published',description:'',trigger:{event:'submitted',days:0,workdays:false,repeat:false,skipIf:''},conditions:[],steps:[{id:'legacy-step',type:'doc',template:'legacy',release:false}]}];
 const shared:AutomationWorkflow[]=[{id:'shared-workflow',module:'off',name:'Resignation accepted',description:'',status:'live',required:true,trigger:{event:'accepted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'notify',type:'notify',conditions:[],to:[],cc:[],params:{}},{id:'letter',type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:'shared'}},{id:'email',type:'sendEmail',conditions:[],to:[],cc:[],params:{emailTemplateId:'mail'}}]}];
 const choices={groups:config.groups,routings:[],people:[{id:'bp',name:'Fictional Business Partner'}]};return{config,shared,choices};
}
it('shows the current review/sign chain and exact workflow steps in the existing list without confusing same-named templates',()=>{
 const {config,shared,choices}=fixture();config.templates[0].versions.push({...config.templates[0].versions[0],version:2,state:'draft',routing:[{id:'future',order:1,action:'sign',who:{kind:'people',userIds:['unpublished']},owner:true}]});
 const before=JSON.stringify(config);
 const metadata=lifecycleTemplateListMetadata(config,shared,choices,(key,values)=>t(key,values));
 render(<NextIntlClientProvider locale="en" messages={messages}><TemplateEditor config={config} listMetadata={metadata} selected="" select={vi.fn()} module="off" setModule={vi.fn()} edit={vi.fn()} editable={false} saved previewCases={[]} users={choices.people} initialFilter="off" showModuleFilter={false}/></NextIntlClientProvider>);
 const docs=screen.getByRole('region',{name:'Document templates'}),rows=within(docs).getAllByRole('listitem'),first=within(rows[0]),second=within(rows[1]);
 expect(first.getByText(/Review Fictional People Ops \+ Approve Fictional Business Partner \(parallel\) → Sign the employee/)).toBeInTheDocument();
 expect(first.getByText(/Used in “Resignation accepted · Shared workflow · Live” · step 2/)).toBeInTheDocument();
 expect(first.queryByText(/Existing clearance/)).toBeNull();expect(second.getByText(/Existing clearance · Legacy case workflow · in use/)).toBeInTheDocument();
 expect(within(docs).queryByText(/unpublished/)).toBeNull();expect(rows).toHaveLength(3); // Onboarding never enters the Offboarding list.
 expect(within(screen.getByRole('region',{name:'Email templates'})).getByText(/Used in “Resignation accepted · Shared workflow · Live” · step 3/)).toBeInTheDocument();
 expect(within(rows[2]).getByText('Not used in the visible workflows')).toBeInTheDocument();
 fireEvent.click(first.getByRole('button',{name:'Edit Acceptance letter'}));expect(screen.getByDisplayValue('Acceptance letter')).toBeDisabled();
 expect(JSON.stringify(config)).toBe(before); // Projection and opening the existing read-only editor do not change saved configuration.
});
it('retains paused/retired references, module identity and draft/removed-route truth without inventing workflow usage',()=>{
 const {config,shared,choices}=fixture();shared[0].status='paused';shared.push({...shared[0],id:'wrong-module',module:'probation',name:'Hidden Probation workflow'});
 config.templates[0].versions[0].state='draft';config.templates[0].versions[0].routing=[{id:'missing',order:1,action:'sign',who:{kind:'routing',routingId:'retired-route'},owner:true}];
 const metadata=lifecycleTemplateListMetadata(config,shared,{...choices,routings:[{id:'retired-route',name:'Existing BP routing',retired:true}]},(key,values)=>t(key,values));
 expect(metadata.documents.shared.signing).toBe('Draft routing: Sign Existing BP routing · Retired');
 expect(metadata.documents.shared.uses.join(' ')).toContain('Paused');expect(metadata.documents.shared.uses.join(' ')).not.toContain('Hidden Probation workflow');
 expect(metadata.documents.onboarding.uses).toEqual(['Not used in the visible workflows']);
 expect(metadata.documents.shared.uses.filter(use=>use.includes('Acceptance email'))).toHaveLength(1); // One email link+PDF, not duplicate use rows.
});

it('does not invent resolved employee signers for an Offboarding template using the runtime HR fallback',()=>{
 const {config,shared,choices}=fixture();config.templates[0].versions[0].routing=[];config.templates[0].hrStep='none';config.templates[0].employeeAck=false;
 const metadata=lifecycleTemplateListMetadata(config,shared,choices,(key,values)=>t(key,values));
 expect(metadata.documents.shared.signing).toBe(t('templates.signing.existing'));
 expect(metadata.documents.shared.signing).not.toContain('Sign the employee');
});
