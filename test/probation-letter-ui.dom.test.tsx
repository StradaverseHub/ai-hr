import {beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {OutcomeEditor} from '../app/lifecycle/probation/outcome-editor';
import {LetterView} from '../app/lifecycle/probation/letter-view';
import {newProbationLetterTemplate} from '../lib/probation-letter-template';
import {probationLetterDocument} from '../lib/probation-letter-document';
import type {ProbationLetterDefinition,ProbationLetterPreview,ProbationLetterView,ProbationOutcomeView} from '../packs/probation/service';
const m=vi.hoisted(()=>({preview:vi.fn(),prepare:vi.fn(),sign:vi.fn(),release:vi.fn(),refresh:vi.fn(),push:vi.fn()}));
vi.mock('../app/lifecycle/probation/actions',()=>({previewLetter:m.preview,prepareLetter:m.prepare,signLetter:m.sign,releaseLetter:m.release}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:m.refresh,push:m.push})}));
const person='employee-user',hr='pbp-user',caseId='case',outcome:ProbationOutcomeView={id:'outcome',partId:'review',outcome:'confirm',state:'awaiting_letter',revision:4,letterFileId:null,releasedAt:null,failure:null,sourceKey:'source',filingState:'not_prepared'};
const template=newProbationLetterTemplate('confirm','template','Reviewed confirmation');template.unfinished=false;template.blocks=[{id:'body',type:'text',text:'Dear {employeeName}',section:'main'},{id:'field',type:'field',fieldId:'note',text:'',section:'main'}];template.fields=[{id:'note',label:'Authorized HR note',type:'text',owner:'hr',pmKey:null,required:true,sensitive:false,options:[],section:'main',width:'full',columns:[],when:null}];
const definitions:ProbationLetterDefinition[]=[{id:'template-version',companyId:'company',key:'confirm',version:2,state:'published',data:template}];
const preview:ProbationLetterPreview={merge:{employeeName:'Fictional Employee',note:'Reviewed note'},blocks:template.blocks,fields:template.fields,route:{version:1,steps:template.route.steps.map(s=>({...s,holderId:s.role==='employee'?person:hr}))},guardrails:{requiredRoles:['employee']},companyId:'company',employmentId:'employment',templateId:'template-version',templateVersion:2,templateName:'Reviewed confirmation',outcomeRevision:4,sourceDigest:'digest'};
const show=(node:React.ReactNode)=>render(<NextIntlClientProvider locale="en" messages={messages}>{node}</NextIntlClientProvider>);
beforeEach(()=>{vi.clearAllMocks();m.preview.mockResolvedValue({ok:true,result:preview});m.prepare.mockResolvedValue({ok:true,result:{partId:'frozen-letter'}});});
describe('source-bound probation letter interactions',()=>{
 it('requires a current server preview and invalidates it after an HR field changes',async()=>{
  show(<OutcomeEditor caseId={caseId} outcome={outcome} templates={definitions}/>);
  const prepare=screen.getByRole('button',{name:'Prepare for signatures'});expect(prepare).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox',{name:/Authorized HR note/}),{target:{value:'First note'}});fireEvent.click(screen.getByRole('button',{name:'Preview letter'}));
  await waitFor(()=>expect(prepare).toBeEnabled());expect(screen.getByText('Dear Fictional Employee')).toBeInTheDocument();
  fireEvent.change(screen.getAllByRole('textbox',{name:/Authorized HR note/})[0],{target:{value:'Changed note'}});expect(prepare).toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'Preview letter'}));await waitFor(()=>expect(prepare).toBeEnabled());fireEvent.click(prepare);
  await waitFor(()=>expect(m.prepare).toHaveBeenCalledWith({outcomeId:'outcome',templateId:'template-version',edits:{note:'Changed note'},revision:4}));expect(m.prepare.mock.calls[0][0]).not.toHaveProperty('pdf');
 });
 it('preserves the preparer edits when native source validation refuses preparation',async()=>{
  m.prepare.mockResolvedValue({ok:false,detail:'Personnel changed. Review the current dates.'});show(<OutcomeEditor caseId={caseId} outcome={outcome} templates={definitions}/>);
  fireEvent.change(screen.getByRole('textbox',{name:/Authorized HR note/}),{target:{value:'Retained draft'}});fireEvent.click(screen.getByRole('button',{name:'Preview letter'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Prepare for signatures'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Prepare for signatures'}));
  await screen.findByRole('alert');expect(screen.getAllByRole('textbox',{name:/Authorized HR note/})[0]).toHaveValue('Retained draft');expect(m.push).not.toHaveBeenCalled();
 });
 it('requires explicit selection when reviewed template families tie',()=>{
  const second={...definitions[0],id:'second-version',key:'second-family',data:{...template,id:'second-family',name:'Second reviewed confirmation'}};
  show(<OutcomeEditor caseId={caseId} outcome={outcome} templates={[...definitions,second]} choices={{templates:[{id:'template-version',familyId:'template',version:2,name:'Reviewed confirmation',score:0},{id:'second-version',familyId:'second-family',version:2,name:'Second reviewed confirmation',score:0}],suggestedTemplateId:null,tie:true}}/>);
  expect(screen.getByRole('combobox',{name:'Published letter template'})).toHaveValue('');expect(screen.getByText('More than one template matches equally. Choose the reviewed template explicitly.')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Preview letter'})).toBeDisabled();expect(m.prepare).not.toHaveBeenCalled();
 });
 it('withholds employee signing until prior HR stages finish and offers no release to an employee',()=>{
  const signing={tenantId:'tenant',companyId:'company',subjectId:'letter',subjectType:'probation',contentRevision:1,contentHash:'a'.repeat(64),route:preview.route,actions:[]};
  const letter:ProbationLetterView={sourceMoved:false,runtimeEnabled:true,id:'letter',caseId,outcomeId:'outcome',outcomeRevision:null,storageRevision:1,state:'issued',createdAt:'',name:'Reviewed confirmation',templateId:'template-version',templateVersion:2,blocks:preview.blocks,fields:preview.fields,merge:preview.merge,signing:{id:'signing',document:signing},canPrepare:false,canRelease:false,document:probationLetterDocument({id:'letter',name:'Reviewed confirmation',...preview,createdAt:'',signing})};
  show(<LetterView letter={letter} actor={{id:person,name:'Fictional Employee'}}/>);expect(screen.queryByRole('button',{name:'Sign and submit'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Release signed letter'})).not.toBeInTheDocument();expect(screen.getByText('Dear Fictional Employee')).toBeInTheDocument();
 });
 it('keeps the frozen letter readable while processing is paused and hides pending signature actions',()=>{
  const signing={tenantId:'tenant',companyId:'company',subjectId:'letter',subjectType:'probation',contentRevision:1,contentHash:'a'.repeat(64),route:preview.route,actions:[]};
  const letter:ProbationLetterView={sourceMoved:false,runtimeEnabled:false,id:'letter',caseId,outcomeId:'outcome',outcomeRevision:4,storageRevision:1,state:'issued',createdAt:'',name:'Reviewed confirmation',templateId:'template-version',templateVersion:2,blocks:preview.blocks,fields:preview.fields,merge:preview.merge,signing:{id:'signing',document:signing},canPrepare:false,canRelease:false,document:probationLetterDocument({id:'letter',name:'Reviewed confirmation',...preview,createdAt:'',signing})};
  show(<LetterView letter={letter} actor={{id:hr,name:'Fictional PBP'}}/>);expect(screen.getByText('Dear Fictional Employee')).toBeInTheDocument();expect(screen.getByText('Processing is paused. Existing records remain available as read-only history.')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'Sign and submit'})).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Release signed letter'})).not.toBeInTheDocument();expect(m.sign).not.toHaveBeenCalled();
 });
});
