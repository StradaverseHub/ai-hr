import {afterEach,beforeEach,expect,it,vi} from 'vitest';
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
import {HistoryWorkflow} from '../app/payroll/history-import/history-workflow';
import {maintenanceDetail,maintenancePage,maintenancePlan,maintenanceEditPlan} from './fixtures/payroll-history/maintenance';
import {captureAiReviewScreenshots,aiReviewDomHtml} from './helpers/ai-review-screenshots';
const mocks=vi.hoisted(()=>({preview:vi.fn(),confirm:vi.fn(),importConfirm:vi.fn(),refresh:vi.fn()}));
vi.mock('../app/payroll/history-import/maintenance-actions',()=>({previewHistoryMaintenanceAction:mocks.preview,confirmHistoryMaintenanceAction:mocks.confirm}));
vi.mock('../app/payroll/history-import/workflow-actions',()=>({confirmHistoryUploadAction:mocks.importConfirm}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:mocks.refresh})}));
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const wrap=(children:React.ReactNode,locale:keyof typeof catalogues='en')=><NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{children}</NextIntlClientProvider>;
beforeEach(()=>{mocks.preview.mockResolvedValue({ok:true,result:{attemptId:'review-attempt',plan:maintenanceEditPlan}});mocks.confirm.mockResolvedValue({ok:true,completed:true});});
afterEach(()=>{cleanup();vi.resetAllMocks();vi.unstubAllGlobals();});
it('previews exact item/revision/reason, retains canonical unlisted totals and confirms only the current reviewed hash',async()=>{
 const user=userEvent.setup();render(wrap(<HistoryMaintenanceControl detail={maintenanceDetail}/>));
 await user.clear(screen.getByLabelText('New total for ALLOWANCE'));await user.type(screen.getByLabelText('New total for ALLOWANCE'),'275.00');
 expect(screen.getByRole('button',{name:'Review changes'})).toBeDisabled();await user.type(screen.getByLabelText('Reason for this change'),'Corrected approved allowance');await user.click(screen.getByRole('button',{name:'Review changes'}));
 expect(mocks.preview).toHaveBeenCalledExactlyOnceWith({version:1,operation:'edit',recordId:'record-fictional',expectedRevisionId:'revision-current',items:[{key:'allowance',amount:'275.00'}],reason:'Corrected approved allowance'});
 const review=within(screen.getByRole('region',{name:'Before-and-after review'}));expect(review.getAllByText('Keep existing total')).toHaveLength(2);expect(within(review.getByRole('region',{name:'Pay Item changes'})).getByText('MYR 275.00')).toBeInTheDocument();
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
