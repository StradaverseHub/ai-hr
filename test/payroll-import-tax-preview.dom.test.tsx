import {afterEach,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import vi from '../messages/vi.json';
import {TaxBasisResults} from '../app/payroll/income-tax-recalculation/results';
import {RevisionPreview} from '../app/payroll/history-import/revision-preview';
import type {TaxBasisEmployee} from '../lib/payroll-tax-basis';
import type {HistoryRevisionPlan,HistoryRevisionRow} from '../lib/payroll-history-revisions';
import {aiReviewDomHtml,captureAiReviewScreenshots} from './helpers/ai-review-screenshots';
const catalogs={en,ms,zh,ta,th,vi};
const missingInputs=['originalStatutoryInputs','originalTaxCategoryAndReliefs','originalPriorEmployerIncome'];
const ready:TaxBasisEmployee={id:'fictional-a',employeeNo:'F001',name:'Sample employee A',status:'ready',reason:null,recordCount:9,beforeTaxable:47700,taxable:45000,difference:-2700,beforeExempt:null,exempt:0,months:[],pcbComparison:{state:'unavailable',originalPaid:1800,missingInputs}};
const held:TaxBasisEmployee={id:'fictional-b',employeeNo:'F002',name:'Sample employee B',status:'blocked',reason:'The original assessment-year exemption usage is not retained.',recordCount:1,beforeTaxable:null,taxable:null,difference:null,beforeExempt:null,exempt:null,months:[],pcbComparison:{state:'unavailable',originalPaid:null,missingInputs},missingEvidence:[{field:'priorEmployerExemptionUsage',affects:['taxableWages','exemptWages','optionalDeductions','pcbComparison'],reason:'The original opening is unknown; it is not an evidenced zero.'}],partialMonths:[{payslipId:'fictional-slip',period:'2026-01',items:[{code:'BASIC',name:'Basic salary',amount:5000,direction:'earning',includedInPcb:true,remunerationType:'normal',exemptionCode:null},{code:'TRAVEL',name:'Annual-cap travel allowance',amount:500,direction:'earning',includedInPcb:true,remunerationType:'normal',exemptionCode:'travel'}]}]};
const setting={id:'fictional-basic',code:'BASIC',name:'Basic salary',kind:'allowance',includedInPcb:true,pcbRemunerationType:'normal',pcbExemptionCode:null,isNonPayable:false,epfBonus2012:false,archivedAt:null};
const benefitSetting={...setting,id:'fictional-benefit',code:'BENEFIT',name:'Fictional BIK',isNonPayable:true,displayCategory:'bik',eaFormLine:'B3'};
const noncashFigures={bik:{entered:700,exempt:0,taxable:700},vola:{entered:0,exempt:0,taxable:0}};
const noncashEntry={kind:'bik',code:'BENEFIT',source:'recurring',entered:700,exempt:0,taxable:700};
const noncashEa={kind:'bik',code:'BENEFIT',source:'recurring',entered:700,reportableAmount:700,exemptAmount:0,eaFormLine:'B3',subjectPCB:true};
const noncashSnapshot={version:1,current:noncashFigures,ownedCurrent:noncashFigures,owned:{bik:700,vola:0},cumulative:{bik:700,vola:0},before:{bik:0,vola:0},accumulated:{bik:0,vola:0,complete:false},cashNormal:5000,entries:[noncashEntry],ownedEntries:[noncashEntry],eaEntries:[noncashEa],ownedEaEntries:[noncashEa]};
function row(state:'ready'|'held'='ready'):HistoryRevisionRow{return{companyId:'fictional-company',companyName:'Fictional Company',currency:'MYR',employmentId:'fictional-employment',employeeNo:'F001',employeeName:'Sample employee A',period:'2026-01',cycleId:'fictional-cycle',cycleName:'Monthly',rowNums:[2,3],operation:'create',reasons:[],recordId:null,expectedRevisionId:null,expectedSnapshotId:null,valueHash:'fictional-value-hash',overwrite:false,codes:['BASIC','BENEFIT'],beforeValues:null,values:{basicSalary:'5000.00',allowance:'0.00',overtimePay:'0.00',bonus:'0.00',grossPay:'5000.00',otherDeductions:'0.00',totalDeductions:'125.00',netPay:'4875.00',employerCost:'5000.00',statutory:{pcb:state==='ready'?125:null,importedTaxBasis:{version:1,state,year:2026,settingsHash:'fictional-settings-hash',settings:[setting,benefitSetting],lines:[{rowNum:2,originalCode:'SALARY',code:'BASIC',settingId:setting.id,amount:5000,direction:'earning'},{rowNum:3,originalCode:'BENEFIT',code:'BENEFIT',settingId:benefitSetting.id,amount:700,direction:'noncash'}],missing:state==='held'?['Original prior-employer exemption usage is not retained.']:[],...(state==='ready'?{basis:{version:1,pcb:5000,pcbNonCash:noncashSnapshot,exemptionUsed:{},items:[],rulesHash:'fictional-rules-hash'}}:{})}}}};}
const plan=(r:HistoryRevisionRow):HistoryRevisionPlan=>({version:1,rows:[r],issues:[],counts:{created:1,replaced:0,unchanged:0,invalid:0},companyIds:['fictional-company'],sourceHash:'fictional-source',previewHash:'fictional-preview'});
afterEach(cleanup);
function show(locale:keyof typeof catalogs='en',importState:'ready'|'held'='ready'){
 return render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]}><main className="mx-auto max-w-6xl space-y-8 p-4"><h1 className="text-2xl font-semibold">Fictional payroll history preview</h1><TaxBasisResults employees={[ready,held]}/><RevisionPreview plan={plan(row(importState))}/></main></NextIntlClientProvider>);
}
it('keeps known partial item amounts/classification visible while all affected final figures and actual PCB remain unavailable',()=>{
 show();const details=screen.getByText(/F002 · Sample employee B/).closest('details')!;fireEvent.click(details.querySelector('summary')!);
 const partial=within(details).getByRole('region',{name:en.payrollTaxBasis.availableItems});expect(partial).toHaveTextContent('BASIC · Basic salary');expect(partial).toHaveTextContent('5,000.00');expect(partial).toHaveTextContent('TRAVEL · Annual-cap travel allowance');expect(partial).toHaveTextContent('500.00');
 expect(partial).toHaveTextContent(en.payrollTaxBasis.includedBeforeExemption);expect(partial).toHaveTextContent(en.payrollTaxBasis.remuneration.normal);
 expect(within(details).getByRole('region',{name:en.payrollTaxBasis.missingEvidenceTitle})).toHaveTextContent(en.payrollTaxBasis.evidenceFields.priorEmployerExemptionUsage);
 const comparison=within(details).getByRole('region',{name:en.payrollTaxBasis.pcbComparisonTitle});expect(comparison).toHaveTextContent(en.payrollTaxBasis.pcbComparisonUnavailable);for(const key of missingInputs)expect(comparison).toHaveTextContent(en.payrollTaxBasis.evidenceFields[key as keyof typeof en.payrollTaxBasis.evidenceFields]);
 // Known source amounts are not presented as confirmed taxable totals; missing imported PCB is not zero.
 expect(comparison).toHaveTextContent(en.payrollTaxBasis.unavailable);expect(comparison).not.toHaveTextContent('0.00');
});
it('separates imported PCB paid, cash wage basis and noncash benefits without dumping internal settings or hashes',()=>{
 show();fireEvent.click(screen.getByText(en.payrollTaxBasis.importWageBasis));const detail=screen.getByRole('region',{name:en.payrollTaxBasis.importWageBasis});
 expect(detail).toHaveTextContent(en.payrollTaxBasis.importBasisReady);expect(detail).toHaveTextContent(en.payrollTaxBasis.originalImportedPcb);expect(detail).toHaveTextContent('125.00');expect(detail).toHaveTextContent(en.payrollTaxBasis.cashPcbWages);expect(detail).toHaveTextContent('5,000.00');expect(detail).toHaveTextContent(en.payrollTaxBasis.noncashPcbWages);expect(detail).toHaveTextContent('700.00');expect(detail).toHaveTextContent('SALARY → BASIC');
 fireEvent.click(screen.getByText(en.payroll.historyRevisions.compare));expect(document.body).not.toHaveTextContent('fictional-settings-hash');expect(document.body).not.toHaveTextContent('importedTaxBasis');expect(document.body).not.toHaveTextContent('settingId');
});
it('does not coerce missing PCB or an incomplete capped basis to zero in the import preview',()=>{
 show('en','held');fireEvent.click(screen.getByText(en.payrollTaxBasis.importWageBasis));const detail=screen.getByRole('region',{name:en.payrollTaxBasis.importWageBasis});expect(detail).toHaveTextContent(en.payrollTaxBasis.importBasisHeld);expect(detail).toHaveTextContent(en.payrollTaxBasis.missingEvidenceHelp);expect(within(detail).getAllByText(en.payrollTaxBasis.unavailable)).toHaveLength(3);expect(detail).not.toHaveTextContent('125.00');expect(detail).toHaveTextContent('5,000.00');
});
it.each(Object.keys(catalogs) as (keyof typeof catalogs)[])('renders the ready, partial, missing-evidence and import wage distinction in %s',locale=>{
 show(locale,'held');const copy=catalogs[locale].payrollTaxBasis;for(const details of document.querySelectorAll('details'))details.setAttribute('open','');
 expect(screen.getByRole('region',{name:copy.availableItems})).toHaveTextContent(copy.includedBeforeExemption);expect(screen.getByRole('region',{name:copy.missingEvidenceTitle})).toHaveTextContent(copy.evidenceFields.priorEmployerExemptionUsage);expect(screen.getByRole('region',{name:copy.importWageBasis})).toHaveTextContent(copy.originalImportedPcb);
});
it.each(['light','dark'] as const)('captures actual ready/partial and import-preview components on desktop/phone (%s)',async mode=>{
 show('en','held');for(const details of document.querySelectorAll('details'))details.setAttribute('open','');
 await captureAiReviewScreenshots(aiReviewDomHtml(document.body),'en',mode==='light'?'feedback-import-pcb-preview-light':'feedback-import-pcb-preview-dark','Actual payroll results and import preview; fictional illustrative amounts; wage inputs are not recalculated PCB; no live payroll or data write','atelier',mode);
},120000);

it('names an evidenced absence of noncash items instead of inventing a zero or calling the known source unavailable',()=>{
 const r=row(),stamp=r.values!.statutory.importedTaxBasis as {lines:{direction:string}[];basis:{pcbNonCash?:unknown}};stamp.lines=stamp.lines.filter(line=>line.direction!=='noncash');delete stamp.basis.pcbNonCash;
 render(<NextIntlClientProvider locale="en" messages={en}><RevisionPreview plan={plan(r)}/></NextIntlClientProvider>);fireEvent.click(screen.getByText(en.payrollTaxBasis.importWageBasis));expect(screen.getByRole('region',{name:en.payrollTaxBasis.importWageBasis})).toHaveTextContent(en.payrollTaxBasis.noNoncashItems);
});
it('keeps monthly cash wages separate from owned/current BIK and VOLA inputs, with noncash item labels',()=>{
 const benefit={code:'BENEFIT',name:'Fictional BIK',amount:700,previousTreatment:null,latestTreatment:'Non-cash BIK · Taxable',taxable:700,exempt:0};
 const employee:TaxBasisEmployee={...ready,months:[{payslipId:'fictional-month',period:'2026-01',sourceHash:'fictional-hash',beforeTaxable:5000,taxable:5000,difference:0,beforeExempt:0,exempt:0,ytdTaxable:5000,ytdExempt:0,items:[benefit],basis:{version:1,pcb:5000,exemptionUsed:{},items:[benefit],rulesHash:'fictional-rules',pcbNonCash:noncashSnapshot}}]};
 render(<NextIntlClientProvider locale="en" messages={en}><TaxBasisResults employees={[employee]}/></NextIntlClientProvider>);for(const details of document.querySelectorAll('details'))details.setAttribute('open','');
 const nc=screen.getByRole('region',{name:en.payrollTaxBasis.noncashPcbWages+' · 2026-01'});expect(nc).toHaveTextContent('BIK');expect(nc).toHaveTextContent('VOLA');expect(within(nc).getAllByText(en.payrollTaxBasis.currentNoncashTaxable)).toHaveLength(2);expect(within(nc).getAllByText(en.payrollTaxBasis.ownedNoncashTaxable)).toHaveLength(2);expect(within(nc).getAllByText(/700\.00/)).toHaveLength(2);
 const item=screen.getByText('BENEFIT · Fictional BIK').closest('div')!;expect(item).toHaveTextContent(en.payrollTaxBasis.noncashPcbWages);expect(item).not.toHaveTextContent(en.payrollTaxBasis.cashPcbWages);expect(screen.getByText(en.payrollTaxBasis.basisNotTax)).toBeVisible();
});
