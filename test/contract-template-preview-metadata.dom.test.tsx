/** Native saved-version metadata remains distinct from CAS and unsaved editor work. */
import {afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ContractDocuments} from '../app/automation/templates/contract-documents';
import type {TemplateVersionEditor as NativeVersionEditor} from '../app/lifecycle/v9/template-version-editor';
import type {AutomationDocumentTemplate} from '../lib/automation/document-template';
import type {AutomationDocumentUsage} from '../packs/automation/service';
const native=vi.hoisted(()=>({usage:vi.fn(),save:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/automation/actions',()=>({documentTemplateUsageAction:native.usage,saveDocumentTemplateAction:native.save,documentTemplateAction:vi.fn(),searchContractTemplateCasesAction:vi.fn(),loadContractTemplatePreviewAction:vi.fn()}));
// Exercise the real host's selected metadata and change/save transitions through the existing child API.
vi.mock('../app/lifecycle/v9/template-version-editor',()=>({TemplateVersionEditor:({version,disabled,change}:Parameters<typeof NativeVersionEditor>[0])=><div><output aria-label="Native preview version">{version.version}</output><output aria-label="Native preview state">{version.state}</output><button disabled={disabled} onClick={()=>change(next=>{const block=next.blocks[0];if(!block)throw Error('The native preview fixture needs its text block');block.text='Unsaved fictional wording';})}>Change preview wording</button></div>}));
const id='11111111-1111-4111-8111-111111111111';
const template:AutomationDocumentTemplate={id,module:'contract_staff',name:'Fictional preview version',description:'',rules:{},blocks:[{id:'intro',type:'text',section:'',text:'Saved fictional wording'}],fields:[],routing:[{id:'review',order:1,action:'review',owner:true,who:{kind:'directSuperior'}}]};
const usage:AutomationDocumentUsage={documents:0,usedByWorkflow:false,deleteReason:null,versions:[{version:2,template,savedAt:'2026-11-18T01:00:00Z',note:'Saved draft two',documents:0,state:'draft',canDelete:true},{version:1,template,savedAt:'2026-11-17T01:00:00Z',note:'Published original',documents:0,state:'inUse',canDelete:false}]};
const copy={previewingVersion:'Previewing version {version} ({status}).',previewUnsavedFrom:'Previewing unsaved changes based on version {version}.',previewUnsaved:'Previewing unsaved draft.',previewState:{draft:'Draft',published:'Published',inUse:'In use',checking:'Checking status'}};
const show=(currentVersion=2,liveVersion=1)=>render(<NextIntlClientProvider locale="en" messages={{...en,automation:{...en.automation,contract:{...en.automation.contract,...copy}}}}><ContractDocuments templates={[{template,revision:7,currentVersion,liveVersion,retired:false}]} refs={{groups:[],people:[],routings:[],conditions:{}}}/></NextIntlClientProvider>);
beforeAll(()=>{Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:function(this:HTMLDialogElement){this.setAttribute('open','');}});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:function(this:HTMLDialogElement){this.removeAttribute('open');}});});
beforeEach(()=>{vi.clearAllMocks();native.usage.mockResolvedValue({ok:true,result:usage});native.save.mockResolvedValue({ok:true,result:{revision:8,warnings:[]}});});
afterEach(cleanup);
describe('Contract template preview identifies its actual saved version',()=>{
 it('shows saved draft two beside published one without inventing a version from CAS seven',async()=>{
  show();fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(await screen.findByText('Previewing version 2 (Draft).')).toBeVisible();
  expect(screen.getByText('Latest version 2 · In use: 1')).toBeVisible();expect(screen.getByLabelText('Native preview version')).toHaveTextContent('2');expect(screen.getByLabelText('Native preview state')).toHaveTextContent('draft');expect(native.save).not.toHaveBeenCalled();
 });
 it('retains the exact state when switching between the in-use version and saved draft history',async()=>{
  show();fireEvent.click(screen.getByRole('button',{name:'Edit'}));await screen.findByText('Previewing version 2 (Draft).');
  fireEvent.click(screen.getByRole('tab',{name:'Version history'}));await screen.findByText('Saved draft two');await waitFor(()=>expect(screen.getByRole('button',{name:'Version 1'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Version 1'}));
  expect(screen.getByText('Previewing version 1 (In use).')).toBeVisible();expect(screen.getByLabelText('Native preview version')).toHaveTextContent('1');expect(screen.getByLabelText('Native preview state')).toHaveTextContent('published');
  fireEvent.click(screen.getByRole('tab',{name:'Version history'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Version 2'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Version 2'}));
  expect(screen.getByText('Previewing version 2 (Draft).')).toBeVisible();expect(screen.getByLabelText('Native preview state')).toHaveTextContent('draft');expect(native.save).not.toHaveBeenCalled();
 });
 it('labels an older published history selection as published rather than the current in-use version',async()=>{
  native.usage.mockResolvedValue({ok:true,result:{...usage,versions:[{...usage.versions[0],version:4,note:'Current draft four'},{...usage.versions[1],version:3,note:'Current publication three'},{...usage.versions[1],version:2,state:'published',note:'Historical publication two'}]}});
  show(4,3);fireEvent.click(screen.getByRole('button',{name:'Edit'}));await screen.findByText('Previewing version 4 (Draft).');fireEvent.click(screen.getByRole('tab',{name:'Version history'}));await screen.findByText('Historical publication two');await waitFor(()=>expect(screen.getByRole('button',{name:'Version 2'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'Version 2'}));
  expect(screen.getByText('Previewing version 2 (Published).')).toBeVisible();expect(screen.getByText('Latest version 4 · In use: 3')).toBeVisible();expect(screen.getByLabelText('Native preview version')).toHaveTextContent('2');
 });
 it('marks unsaved edits explicitly and adopts only the actual native saved-version receipt',async()=>{
  show();fireEvent.click(screen.getByRole('button',{name:'Edit'}));await screen.findByText('Previewing version 2 (Draft).');fireEvent.click(screen.getByRole('button',{name:'Change preview wording'}));
  expect(screen.getByText('Previewing unsaved changes based on version 2.')).toBeVisible();expect(screen.getByLabelText('Native preview version')).toHaveTextContent('2');expect(screen.queryByText('Previewing version 8 (Draft).')).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));expect(await screen.findByText('Previewing version 8 (Draft).')).toBeVisible();expect(screen.getByLabelText('Native preview version')).toHaveTextContent('8');expect(native.save).toHaveBeenCalledWith(expect.objectContaining({expectedRevision:7,publish:false}));expect(screen.queryByText('Previewing unsaved changes based on version 2.')).toBeNull();
 });
 it('never assigns a saved number to a new unsaved template',()=>{
  show();fireEvent.click(screen.getByRole('button',{name:'New document template'}));expect(screen.getByText('Previewing unsaved draft.')).toBeVisible();expect(native.save).not.toHaveBeenCalled();
 });
});
