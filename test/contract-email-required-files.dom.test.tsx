/** Real version-specific file component; fictional typed projections, not an authenticated journey. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {ContractEmailCaseFiles,type ContractEmailFileSet} from '../app/automation/templates/automation-email-assets';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const actions=vi.hoisted(()=>({refresh:vi.fn(),page:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:actions.refresh})}));
vi.mock('../app/automation/templates/assets/actions',()=>({readContractEmailFilePage:actions.page}));
const id='11111111-1111-4111-8111-111111111111',caseId='22222222-2222-4222-8222-222222222222',pin='33333333-3333-4333-8333-333333333333',slot='44444444-4444-4444-8444-444444444444';
const sets:ContractEmailFileSet[]=[{templateId:id,templateName:'Contract update',revision:1,prerequisiteId:pin,sourcePeriodRevision:'fictional-original-source',slots:[{id:slot,label:'Employee voucher',required:true,file:null}]},{templateId:id,templateName:'Contract update',revision:2,sourcePeriodRevision:'fictional-current-source',slots:[{id:slot,label:'Employee voucher',required:true,file:null}]}];
const mount=()=>render(<NextIntlClientProvider locale="en" messages={en}><main className="v9-workspace automation"><h1 className="v9-heading">Email files</h1><ContractEmailCaseFiles caseId={caseId} items={sets} editable/></main></NextIntlClientProvider>);
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.clearAllMocks();});
it('shows each original waiting version independently and submits only the selected pending hint',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({asset:{id:'55555555-5555-4555-8555-555555555555',kind:'file',name:'voucher.txt',mimeType:'text/plain',size:17,contentHash:'a'.repeat(64),at:'2026-11-17T00:00:00.000Z',by:'Fictional operator'}})});vi.stubGlobal('fetch',fetch);
 const view=mount();expect(screen.getByText(/^Email version 1/)).toBeVisible();expect(screen.getByText('Email version 2')).toBeVisible();expect(screen.getByText(/Waiting email/)).toBeVisible();expect(view.container.textContent).not.toContain('fictional-original-source');
 const first=screen.getAllByRole('heading',{name:'Contract update'})[0].parentElement!;
 fireEvent.change(within(first).getByLabelText(/Employee voucher/),{target:{files:[new File(['Fictional voucher'],'voucher.txt',{type:'text/plain'})]}});
 await waitFor(()=>expect(actions.refresh).toHaveBeenCalledOnce());
 const data=fetch.mock.calls[0][1].body as FormData;expect(data.get('prerequisiteId')).toBe(pin);expect(data.get('revision')).toBe('1');expect(data.get('caseId')).toBe(caseId);expect(data.get('slotId')).toBe(slot);expect(data.has('sourcePeriodRevision')).toBe(false);
 await captureAiReviewScreenshots(aiReviewDomHtml(view.container),'en','contract-required-email-files','Actual React file component with typed fictional current and frozen pending versions; mocked authorized upload response; no installed/authenticated journey','atelier');
},120000);
it('keeps the latest legacy upload separate and sends no pending hint for it',async()=>{
 const fetch=vi.fn().mockResolvedValue({ok:false,json:async()=>({error:'The Personnel period changed. Reload the case.'})});vi.stubGlobal('fetch',fetch);mount();
 const current=screen.getAllByRole('heading',{name:'Contract update'})[1].parentElement!;
 fireEvent.change(within(current).getByLabelText(/Employee voucher/),{target:{files:[new File(['Fictional voucher'],'voucher.txt',{type:'text/plain'})]}});
 expect(await screen.findByRole('alert')).toHaveTextContent('The Personnel period changed. Reload the case.');
 const data=fetch.mock.calls[0][1].body as FormData;expect(data.has('prerequisiteId')).toBe(false);expect(data.get('revision')).toBe('2');expect(actions.refresh).not.toHaveBeenCalled();
});
