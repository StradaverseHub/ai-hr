import {afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {HistoryMaintenanceControl} from '../app/payroll/history-import/maintenance-control';
import {HistoryMaintenanceRecords} from '../app/payroll/history-import/records-view';
import {HistoryMaintenanceAudit} from '../app/payroll/history-import/maintenance-audit';
import {RevisionPreview} from '../app/payroll/history-import/revision-preview';
import {RevertControl} from '../app/payroll/history-import/logs/[attemptId]/revert-control';
import type {PayrollHistoryMaintenanceRequest} from '../lib/payroll-history-maintenance';
import {HistoryWorkflow} from '../app/payroll/history-import/history-workflow';
import {maintenanceDetail,maintenancePage,maintenancePlan,maintenanceEditPlan,maintenanceRemovalPlan,maintenanceBatchPlan} from './fixtures/payroll-history/maintenance';
import {captureAiReviewScreenshots,aiReviewDomHtml,applicationCss} from './helpers/ai-review-screenshots';
const mocks=vi.hoisted(()=>({preview:vi.fn(),confirm:vi.fn(),importConfirm:vi.fn(),revertPreview:vi.fn(),revertApply:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/payroll/history-import/maintenance-actions',()=>({previewHistoryMaintenanceAction:mocks.preview,confirmHistoryMaintenanceAction:mocks.confirm}));
vi.mock('../app/payroll/history-import/workflow-actions',()=>({confirmHistoryUploadAction:mocks.importConfirm,previewHistoryRevertAction:mocks.revertPreview,revertHistoryUploadAction:mocks.revertApply}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const wrap=(children:React.ReactNode,locale:keyof typeof catalogues='en')=><NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{children}</NextIntlClientProvider>;
// Compile the shared application stylesheet once as renderer setup. Its cold PostCSS cost
// is not a user interaction/capture; every actual scenario keeps its existing 30-second deadline.
beforeAll(async()=>{
 if(process.env.GITHUB_ACTIONS==='true'&&process.env.AIHR_FOCUSED_EVIDENCE_DIR){const started=performance.now();await applicationCss();console.info('payroll-history-ui-renderer-css-ready-ms',Math.round(performance.now()-started));}
},90000);
beforeEach(()=>{mocks.preview.mockImplementation(async(input:PayrollHistoryMaintenanceRequest)=>{const plan=input.operation==='remove_batch'?maintenanceBatchPlan:input.operation==='remove_items'?maintenanceRemovalPlan:maintenanceEditPlan;return{ok:true,result:{attemptId:'review-attempt',plan:{...plan,maintenance:{...plan.maintenance!,reason:input.reason}}}};});mocks.revertPreview.mockResolvedValue({ok:true,result:{attemptId:'attempt-original',count:1,previewHash:'fictional-revert-hash',plan:maintenanceBatchPlan,impact:maintenanceDetail.impact}});mocks.confirm.mockResolvedValue({ok:true,completed:true});});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.unstubAllGlobals();});
it('previews exact item/revision/reason, retains canonical unlisted totals and confirms only the current reviewed hash',async()=>{
 const user=userEvent.setup();render(wrap(<HistoryMaintenanceControl detail={maintenanceDetail}/>));
 await user.clear(screen.getByLabelText('New total for ALLOWANCE'));await user.type(screen.getByLabelText('New total for ALLOWANCE'),'275.00');
 expect(screen.getByRole('button',{name:'Review changes'})).toBeDisabled();await user.type(screen.getByLabelText('Reason for this change'),'Corrected approved allowance');await user.click(screen.getByRole('button',{name:'Review changes'}));
 expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({version:1,operation:'edit',recordId:'record-fictional',expectedRevisionId:'revision-current',items:[{key:'allowance',amount:'275.00'}],reason:'Corrected approved allowance'});
 expect(screen.getByRole('heading',{name:'Before-and-after review'})).toHaveFocus();const review=within(screen.getByRole('region',{name:'Before-and-after review'}));expect(review.getAllByText('Keep existing total')).toHaveLength(2);expect(within(review.getByRole('region',{name:'Pay Item changes'})).getByText('MYR 275.00')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'Confirm history changes'})).toBeDisabled();await user.click(review.getByRole('checkbox'));await user.click(screen.getByRole('button',{name:'Confirm history changes'}));expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith({attemptId:'review-attempt',previewHash:'fictional-preview-hash'});expect(await screen.findByRole('status')).toHaveTextContent('History changes committed');
});
it('invalidates the reviewed intent after an amount change and retains edits on a transport failure',async()=>{
 const user=userEvent.setup();render(wrap(<HistoryMaintenanceControl detail={maintenanceDetail}/>));
 fireEvent.change(screen.getByLabelText('New total for ALLOWANCE'),{target:{value:'270.00'}});fireEvent.change(screen.getByLabelText('Reason for this change'),{target:{value:'Review correction'}});await user.click(screen.getByRole('button',{name:'Review changes'}));expect(screen.getByRole('button',{name:'Confirm history changes'})).toBeDisabled();
 fireEvent.change(screen.getByLabelText('New total for ALLOWANCE'),{target:{value:'280.00'}});expect(screen.queryByRole('button',{name:'Confirm history changes'})).not.toBeInTheDocument();
 mocks.preview.mockRejectedValue(Error('Connection lost'));await user.click(screen.getByRole('button',{name:'Review changes'}));expect(await screen.findByRole('alert')).toHaveTextContent('not saved');expect(screen.getByLabelText('New total for ALLOWANCE')).toHaveValue('280.00');expect(screen.getByLabelText('Reason for this change')).toHaveValue('Review correction');expect(mocks.confirm).not.toHaveBeenCalled();
});
it('previews selected removal and batch lineage without sending a removal before ordinary confirmation',async()=>{
 const user=userEvent.setup();const {unmount}=render(wrap(<HistoryMaintenanceControl detail={maintenanceDetail}/>));await user.click(screen.getByLabelText('Remove selected items'));await user.click(screen.getByLabelText('Remove ALLOWANCE'));await user.type(screen.getByLabelText('Reason for this change'),'Duplicate imported amount');await user.click(screen.getByRole('button',{name:'Review changes'}));
 expect(mocks.preview).toHaveBeenCalledWith({version:1,operation:'remove_items',recordId:'record-fictional',expectedRevisionId:'revision-current',itemKeys:['allowance'],reason:'Duplicate imported amount'});expect(mocks.confirm).not.toHaveBeenCalled();
 unmount();render(wrap(<HistoryMaintenanceControl attemptId="attempt-original"/>));await user.type(screen.getByLabelText('Reason for this change'),'Wrong original batch');await user.click(screen.getByRole('button',{name:'Review changes'}));expect(mocks.preview).toHaveBeenLastCalledWith({version:1,operation:'remove_batch',attemptId:'attempt-original',reason:'Wrong original batch'});expect(screen.getAllByText('Later correction retained').length).toBeGreaterThan(0);expect(mocks.confirm).not.toHaveBeenCalled();
});
it('rejects invalid or stale reviews, respects item permissions, and preserves SQL list count/page filters',async()=>{
 const user=userEvent.setup();mocks.preview.mockResolvedValue({ok:false,error:'The accepted revision changed. Review again.'});const {unmount}=render(wrap(<HistoryMaintenanceControl detail={maintenanceDetail}/>));fireEvent.change(screen.getByLabelText('New total for ALLOWANCE'),{target:{value:'280.00'}});fireEvent.change(screen.getByLabelText('Reason for this change'),{target:{value:'Correction'}});await user.click(screen.getByRole('button',{name:'Review changes'}));expect(screen.getByRole('alert')).toHaveTextContent('revision changed');expect(screen.queryByRole('button',{name:'Confirm history changes'})).not.toBeInTheDocument();
 unmount();const shown=render(wrap(<HistoryMaintenanceControl detail={{...maintenanceDetail,canEdit:false,canRemove:false}}/>));expect(screen.getByLabelText('New total for ALLOWANCE')).toBeDisabled();expect(screen.getByLabelText('Remove selected items')).toBeDisabled();shown.unmount();
 render(wrap(<HistoryMaintenanceRecords page={{...maintenancePage,total:51,items:Array.from({length:50},(_,index)=>({...maintenancePage.items[0],id:'record-'+index,employeeNo:'F'+String(index+1).padStart(3,'0')}))}} query={{search:'Sample',period:'2026-01',companyId:'company-fictional',includeWithdrawn:true}} companies={[{id:'company-fictional',name:'Fictional Company'}]}/>));expect(screen.getByRole('status')).toHaveTextContent('51 imported records');expect(screen.getByRole('link',{name:'Next'})).toHaveAttribute('href','?companyId=company-fictional&period=2026-01&search=Sample&includeWithdrawn=on&offset=50');
});
it('passes the chosen import mode while preserving file bytes and clears a stale preview on mode change',async()=>{
 const user=userEvent.setup(),fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({attemptId:'review-attempt',plan:maintenancePlan})});vi.stubGlobal('fetch',fetcher);render(wrap(<HistoryWorkflow codes={[]}/>));
 await user.click(screen.getByLabelText(/Update listed Pay Item totals/));const file=new File(['Fictional source bytes'],'sample.csv',{type:'text/csv'});await user.upload(screen.getByLabelText('Source file'),file);await user.click(screen.getByRole('button',{name:'Validate file'}));expect(fetcher).toHaveBeenCalledWith('/payroll/history-import/upload?name=sample.csv&mode=update_listed',expect.objectContaining({body:file}));expect(screen.getByText(/Repeated rows and aliases/)).toBeInTheDocument();expect(screen.getByRole('button',{name:'Confirm history changes'})).toBeDisabled();
 await user.click(screen.getByLabelText(/Replace selected complete records/));expect(screen.queryByRole('button',{name:'Confirm history changes'})).not.toBeInTheDocument();expect(mocks.importConfirm).not.toHaveBeenCalled();
});
const scenarios=(Object.keys(catalogues) as (keyof typeof catalogues)[]).flatMap(locale=>(['classic','atelier','monolith'] as const).flatMap(theme=>(['light','dark'] as const).map(mode=>({locale,theme,mode}))));
it.each(scenarios)('renders actual payroll maintenance views in $locale / $theme / $mode on phone and desktop',async({locale,theme,mode})=>{
 const t=catalogues[locale].payrollHistoryMaintenance,old=catalogues[locale].payroll.historyRevisions,user=userEvent.setup();
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({attemptId:'review-attempt',plan:maintenancePlan})}));
 const {container}=render(wrap(<div className="mx-auto max-w-7xl space-y-6"><h1 className="text-2xl font-semibold">{t.title}</h1><HistoryWorkflow codes={[]}/><HistoryMaintenanceRecords page={maintenancePage} query={{}} companies={[{id:'company-fictional',name:'Fictional Company'}]}/><HistoryMaintenanceControl detail={maintenanceDetail}/><HistoryMaintenanceAudit detail={maintenanceDetail}/></div>,locale));
 await user.click(screen.getByLabelText(new RegExp(t.update_listed)));await user.upload(screen.getByLabelText(old.file),new File(['Fictional bytes'],'sample.csv',{type:'text/csv'}));await user.click(screen.getByRole('button',{name:old.validate}));
 fireEvent.change(screen.getByLabelText(t.newTotal.replace('{code}','ALLOWANCE')),{target:{value:'275.00'}});fireEvent.change(screen.getByLabelText(t.reason),{target:{value:'Fictional reviewed correction'}});await user.click(screen.getByRole('button',{name:t.reviewChanges}));
 expect(within(screen.getByRole('region',{name:t.maintainItems})).getByRole('button',{name:t.confirmChanges})).toBeDisabled();expect(screen.queryByText(/payrollHistoryMaintenance\./)).not.toBeInTheDocument();
 await captureAiReviewScreenshots(aiReviewDomHtml(container),locale,`feedback-5b47be17-maintenance-${theme}-${mode}`,'Actual upload preview, SQL-paged records, item review and audit components; fictional service output; no installed payroll operation',theme,mode);
},30000);

it('does not expose internal maintenance source snapshots as statutory money and labels exports without claiming settlement',()=>{
 const plan={...maintenanceEditPlan,rows:maintenanceEditPlan.rows.map(row=>({...row,values:{...row.values!,statutory:{...row.values!.statutory,historyMaintenance:{version:1,items:[{id:'opaque-owned-source-id'}]}}}}))};
 render(wrap(<><RevisionPreview plan={plan}/><HistoryMaintenanceAudit detail={maintenanceDetail}/></>));
 expect(screen.queryByText(/opaque-owned-source-id|statutory.historyMaintenance/)).not.toBeInTheDocument();for(const label of ['Pay Item changes','Audit history'])expect(within(screen.getByRole('region',{name:label})).getByText('2 recorded payment-summary exports stay unchanged. This is not evidence of bank settlement.')).toBeInTheDocument();
});
it.each(scenarios)('renders actual selected-item, batch and compatibility removal reviews in $locale / $theme / $mode',async({locale,theme,mode})=>{
 const t=catalogues[locale].payrollHistoryMaintenance,old=catalogues[locale].payroll.historyRevisions,user=userEvent.setup();
 const {container}=render(wrap(<div className="mx-auto max-w-7xl space-y-6"><h1 className="text-2xl font-semibold">{t.title}</h1><HistoryMaintenanceControl detail={maintenanceDetail}/><HistoryMaintenanceControl attemptId="attempt-original"/><div data-testid="compatibility-revert"><RevertControl attemptId="attempt-original" count={2}/></div></div>,locale));
 const item=within(screen.getByRole('region',{name:t.maintainItems}));await user.click(item.getByLabelText(t.remove_items));await user.click(item.getByLabelText(t.removeCode.replace('{code}','ALLOWANCE')));fireEvent.change(item.getByLabelText(t.reason),{target:{value:'Fictional removal of incorrect allowance'}});await user.click(item.getByRole('button',{name:t.reviewChanges}));expect(item.getByRole('button',{name:t.confirmChanges})).toBeDisabled();expect(item.getByText(t.itemOperations.remove)).toBeInTheDocument();
 const batch=within(screen.getByRole('region',{name:t.remove_batch}));fireEvent.change(batch.getByLabelText(t.reason),{target:{value:'Fictional original batch removal'}});await user.click(batch.getByRole('button',{name:t.reviewChanges}));expect(batch.getByRole('button',{name:t.confirmChanges})).toBeDisabled();expect(batch.getByText(t.laterCorrection)).toBeInTheDocument();
 const compatibility=within(screen.getByTestId('compatibility-revert'));await user.click(compatibility.getByRole('button',{name:old.reviewRevert}));expect(compatibility.getByRole('button',{name:old.revert})).toBeDisabled();expect(mocks.confirm).not.toHaveBeenCalled();expect(mocks.revertApply).not.toHaveBeenCalled();
 await captureAiReviewScreenshots(aiReviewDomHtml(container),locale,`feedback-5b47be17-removal-${theme}-${mode}`,'Actual selected-item removal, original-batch contribution removal and compatibility Revert review; fictional later correction retained; no live operation',theme,mode);
},30000);

it('keeps unknown lineage distinct from empty history and does not offer source links beyond batch access',()=>{
 const unavailable={...maintenanceDetail,items:[],itemCount:0,canEdit:false,canRemove:false,unavailableReason:'The immutable source lineage requires review.'};
 const {unmount}=render(wrap(<HistoryMaintenanceControl detail={unavailable}/>));expect(screen.getByRole('status')).toHaveTextContent('Pay Item breakdown unavailable.');expect(screen.getByRole('status')).toHaveTextContent('immutable source lineage');expect(screen.queryByText('No effective imported items.')).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:'Review changes'})).not.toBeInTheDocument();unmount();
 const current={...maintenanceDetail,items:[{...maintenanceDetail.items[0],sourceName:null}],audit:[{...maintenanceDetail.audit[0],sourceName:''}]};const shown=render(wrap(<><HistoryMaintenanceControl detail={current}/><HistoryMaintenanceAudit detail={current}/></>));expect(screen.queryByRole('link')).not.toBeInTheDocument();expect(screen.getAllByText('The original file requires access to the complete import batch.')).toHaveLength(2);shown.unmount();
 render(wrap(<HistoryMaintenanceRecords page={{...maintenancePage,items:[{...maintenancePage.items[0],employeeName:''}]}} query={{}} companies={[]}/>));expect(screen.getByRole('heading',{name:'F001'})).toHaveTextContent(/^F001$/);expect(screen.getByText('Not recorded')).toBeInTheDocument();expect(screen.queryByText('Sample employee')).not.toBeInTheDocument();
});

it('distinguishes a recorded later correction from a promise to retain an explicitly removed item',()=>{
 const {unmount}=render(wrap(<HistoryMaintenanceControl detail={maintenanceDetail}/>));expect(screen.getByText('Later correction recorded')).toBeInTheDocument();expect(screen.queryByText('Later correction retained')).not.toBeInTheDocument();unmount();
 const removed={...maintenanceRemovalPlan,rows:maintenanceRemovalPlan.rows.map(row=>({...row,itemChanges:[{key:'meal',code:'MEAL',label:'Meal allowance',before:'80.00',after:null,operation:'remove' as const,laterCorrection:true}]}))};render(wrap(<RevisionPreview plan={removed}/>));expect(screen.getByText('Remove Pay Item')).toBeInTheDocument();expect(screen.queryByText('Later correction retained')).not.toBeInTheDocument();
});
