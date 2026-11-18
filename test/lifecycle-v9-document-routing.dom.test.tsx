import {beforeEach,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {initializePersonnelCompletion} from '../lib/lifecycle-v9-personnel-completion';
import {readFileSync} from 'node:fs';
import {V9RoutedDocument} from '../app/me/document-signing/routed-document';
import {RoutedDocumentSummary} from '../app/me/document-signing/summary';
import type {V9DocumentSigningWork} from '../packs/lifecycle/service';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
import messages from '../messages/en.json';
const mocks=vi.hoisted(()=>({act:vi.fn(),edit:vi.fn(),refresh:vi.fn(),navigate:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.navigate})}));
vi.mock('../app/me/document-signing/actions',()=>({submitRoutedDocumentCompletion:vi.fn(),actOnRoutedDocument:mocks.act,editRoutedDocument:mocks.edit,refreshRoutedDocument:mocks.refresh}));
beforeEach(()=>vi.clearAllMocks());
function item():V9DocumentSigningWork{
 const signing={tenantId:'tenant',companyId:'company',subjectId:'document',subjectType:'lifecycle_v9',contentHash:'a'.repeat(64),contentRevision:1,route:{version:1,steps:[{id:'review',role:'people',kind:'review' as const,stage:1,holderId:'hr',required:true,owner:true,label:'Fictional HR'},{id:'sign',role:'employee',kind:'sign' as const,stage:2,holderId:'employee',required:true,label:'Fictional employee'}]},actions:[],routing:{templateId:'template',templateVersion:1,caseOwnerId:'hr',fallbackGroupId:null}};
 return {caseId:'case',caseRevision:3,number:'OFB-123',state:'submitted',documentId:'document',name:'Fictional handover record',signing,document:{id:'document',templateId:'template',version:1,name:'Fictional handover record',status:'draft',blocks:[{id:'wording',type:'text',text:'Please review this handover record.',section:''},{id:'field',type:'field',text:'',section:'',fieldId:'answer'}],fields:[{id:'answer',label:'Handover answer',type:'text',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'',when:null}],values:{answer:''},edits:{},mergeValues:{},hrSignature:null,employeeSignature:null,createdAt:'2026-11-18T00:00:00Z',sentAt:null,signing}};
}
function view(value=item(),actor={id:'hr',name:'Fictional HR'}){return render(<NextIntlClientProvider locale="en" messages={messages}><div className="v9-workspace"><V9RoutedDocument initial={value} actor={actor}/></div></NextIntlClientProvider>);}
it('saves only employee-owned preparation answers and prevents signing before the assigned step',async()=>{
 const value=item();mocks.edit.mockResolvedValue({ok:true,item:{...value,caseRevision:4,document:{...value.document!,values:{answer:'Complete'}}}});view(value,{id:'employee',name:'Fictional employee'});
 expect(screen.queryByRole('button',{name:'Sign and submit'})).not.toBeInTheDocument();expect(screen.getByText(/Complete your employee fields before the first signature/)).toBeVisible();
 fireEvent.change(screen.getByLabelText('Handover answer *'),{target:{value:'Complete'}});fireEvent.click(screen.getByRole('button',{name:'Save fields'}));await waitFor(()=>expect(mocks.edit).toHaveBeenCalledWith({caseId:'case',caseRevision:3,documentId:'document',values:{answer:'Complete'}}));
});
it('offers current reviewer wording edits and requires a send-back comment',async()=>{
 mocks.act.mockResolvedValue({ok:false});view();expect(screen.getByRole('button',{name:'Send back'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'Edit wording'}));expect(screen.getByLabelText('Text block 1')).toHaveValue('Please review this handover record.');expect(screen.queryByRole('button',{name:'Confirm Review'})).not.toBeInTheDocument();
});
it('keeps the exact saved document identity in the HR handoff and renders localized route status in light and dark mobile/desktop evidence',async()=>{
 const value=item(),result=view();expect(screen.getByRole('button',{name:'Confirm Review'})).toBeVisible();
 const html='<style>'+readFileSync('app/lifecycle/v9/workspace.css','utf8')+'</style>'+aiReviewDomHtml(result.container);
 for(const mode of ['light','dark'] as const)await captureAiReviewScreenshots(html,'en',`feedback-v9-document-routing-${mode}`,'Actual V9 routed signing component, fictional immutable route and document; service authority exercised in DB suite','classic',mode);
 result.unmount();render(<NextIntlClientProvider locale="en" messages={messages}><RoutedDocumentSummary document={value.document!} caseId="case"/></NextIntlClientProvider>);expect(screen.getByRole('link',{name:'Open signing and review'})).toHaveAttribute('href','/me/document-signing?case=case&document=document');
},60000);

it('keeps a pending second routed signature available on the canonical frozen content',async()=>{
 const value=item();value.document!.values.answer='Frozen handover answer';initializePersonnelCompletion(value.document!,{country:'MY',sourceFingerprint:'frozen-source',officialValues:{},actor:{id:'hr',name:'Fictional HR'},at:'2026-11-18T00:00:00.000Z'});value.signing.route.steps[0].kind='sign';value.signing.actions=[{id:'first-signature',stepId:'review',contentRevision:1,contentHash:value.signing.contentHash,actorId:'hr',actorPersonId:'hr-person',actorName:'Fictional HR',representedId:'hr',role:'people',at:'2026-11-18T01:00:00.000Z',action:'signed',comment:'',signature:{method:'typed',value:'Fictional HR',consent:true}}];mocks.act.mockResolvedValue({ok:true,item:value});view(value,{id:'employee',name:'Fictional employee'});
 const answer=screen.getByRole('textbox',{name:'Handover answer *'});expect(answer).toBeDisabled();fireEvent.change(answer,{target:{value:''}});expect(answer).toHaveValue('Frozen handover answer');expect(screen.queryByRole('button',{name:'Save fields'})).not.toBeInTheDocument();fireEvent.click(screen.getByRole('checkbox'));expect(screen.getByRole('button',{name:'Sign and submit'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Sign and submit'}));await waitFor(()=>expect(mocks.act).toHaveBeenCalledWith(expect.objectContaining({stepId:'sign',action:'signed',contentHash:value.signing.contentHash,contentRevision:1})));expect(mocks.edit).not.toHaveBeenCalled();
});
