import {beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ContractDocuments} from '../app/automation/templates/contract-documents';
import type {AutomationDocumentTemplate} from '../lib/automation/document-template';
const native=vi.hoisted(()=>({usage:vi.fn(),act:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({documentTemplateUsageAction:native.usage,documentTemplateAction:native.act,saveDocumentTemplateAction:vi.fn(),searchContractTemplateCasesAction:vi.fn(),loadContractTemplatePreviewAction:vi.fn(),searchPeopleAction:vi.fn()}));
const id='11111111-1111-4111-8111-111111111111';
const template:AutomationDocumentTemplate={id,module:'contract_staff',name:'Fictional versioned letter',description:'',rules:{},blocks:[{id:'intro',type:'text',section:'',text:'Fictional wording'}],fields:[],routing:[{id:'review',order:1,action:'review',owner:true,who:{kind:'directSuperior'}}]};
const usage={documents:0,usedByWorkflow:false,deleteReason:null,versions:[{version:2,template,savedAt:'2026-11-17T01:00:00Z',note:'Reviewed wording',documents:0,state:'draft',canDelete:true},{version:1,template,savedAt:'2026-11-16T01:00:00Z',note:'Original',documents:0,state:'inUse',canDelete:false}]};
beforeAll(()=>{Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});});
beforeEach(()=>{vi.clearAllMocks();native.usage.mockResolvedValue({ok:true,result:usage});native.act.mockResolvedValue({ok:true,result:{revision:4}});});
const show=()=>render(<NextIntlClientProvider locale="en" messages={en}><ContractDocuments templates={[{template,revision:3,currentVersion:2,liveVersion:1,retired:false}]} refs={{groups:[],people:[],routings:[],conditions:{}}}/></NextIntlClientProvider>);
describe('Document display version and concurrency revision',()=>{
 it('shows the real latest content version and submits the separate native CAS token when publishing history',async()=>{
  show();fireEvent.click(screen.getByRole('button',{name:'Edit'}));expect(await screen.findByText('Latest version 2 · In use: 1')).toBeVisible();fireEvent.click(screen.getByRole('tab',{name:'Version history'}));await screen.findByText('Reviewed wording');
  native.usage.mockResolvedValue({ok:true,result:{...usage,versions:usage.versions.map(row=>({...row,state:row.version===2?'inUse':'published'}))}});fireEvent.click(screen.getAllByRole('button',{name:'Publish'})[1]);await waitFor(()=>expect(native.act).toHaveBeenCalledWith({id,expectedRevision:3,action:'publishVersion',version:2}));expect(await screen.findByText('Latest version 2 · In use: 2')).toBeVisible();
 });
 it('does not apply a delayed usage response after its document editor has closed',async()=>{
  let resolve!:(value:unknown)=>void;native.usage.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));show();fireEvent.click(screen.getByRole('button',{name:'Edit'}));fireEvent.click(screen.getByRole('button',{name:'Back to templates'}));resolve({ok:true,result:usage});
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(screen.getByRole('button',{name:'Edit'})).toBeVisible();expect(screen.queryByText('Reviewed wording')).toBeNull();
 });
});
