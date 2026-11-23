/** Board item 0af23331: the results screen formats the service's exemption ledger, opening source, warnings and held
 * ranges in every locale. Fictional employees; every figure is supplied, none is calculated by the screen. */
import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
import {TaxBasisResults} from '../app/payroll/income-tax-recalculation/results';
import {formatMoney} from '../lib/money';
import type {TaxBasisEmployee,TaxBasisLedgerEntry,TaxBasisMonth} from '../lib/payroll-tax-basis';

const catalogs={en,ms,zh,ta,th,vi:viMessages};
type Locale=keyof typeof catalogs;
afterEach(cleanup);

const entry=(period:string,usedBefore:number,exempt:number,excess:number):TaxBasisLedgerEntry=>({payslipId:'slip-'+period,period,itemCode:'A0080',itemName:'Travel Allowance',code:'PCB_TRA_BUSINESS',cap:6000,usedBefore,remainingBefore:6000-usedBefore,eligible:800,exempt,excess,usedAfter:usedBefore+exempt,remainingAfter:6000-usedBefore-exempt});
const month=(period:string,ledger:TaxBasisLedgerEntry[]|null):TaxBasisMonth=>({payslipId:'slip-'+period,period,sourceHash:'h',beforeTaxable:5000,difference:300,taxable:5300,beforeExempt:800,exempt:500,ytdTaxable:5300,ytdExempt:500,items:[],basis:{version:1,pcb:5300,exemptionUsed:{},items:[],rulesHash:'r',...(ledger?{exemptionLedger:{version:1,entries:ledger}}:{})}});
const common={recordCount:1,beforeTaxable:5000,taxable:5300,difference:300,beforeExempt:800,exempt:500,reason:null} as const;
const accepted:TaxBasisEmployee={...common,id:'a',employeeNo:'E-0412',name:'Example Employee A',status:'ready',openingExemptionSource:'accepted_tp3',
 openingExemption:{source:'accepted_tp3',used:{PCB_TRA_BUSINESS:5500},tp3:{kind:'form',id:'tp3-a',revision:'1'}},
 exemptionLedger:[{code:'PCB_TRA_BUSINESS',cap:6000,openingUsed:5500,openingSource:'accepted_tp3',eligible:800,exempt:500,excess:300,usedAfter:6000,remaining:0,items:[{code:'A0080',name:'Travel Allowance'}]}],
 months:[month('2026-04',[{...entry('2026-04',5500,500,300),remainingAfter:0}])],
 pcbComparison:{state:'unavailable',originalPaid:1234.5,missingInputs:['originalStatutoryInputs']}};
const declared:TaxBasisEmployee={...common,id:'b',employeeNo:'E-0433',name:'Example Employee B',status:'ready',openingExemptionSource:'no_accepted_tp3',
 openingExemption:{source:'no_accepted_tp3',used:{},previousEmployerDeclared:true},
 exemptionLedger:[{code:'PCB_TRA_BUSINESS',cap:6000,openingUsed:0,openingSource:'no_accepted_tp3',eligible:800,exempt:800,excess:0,usedAfter:800,remaining:5200,items:[{code:'A0080',name:'Travel Allowance'}]}],
 months:[month('2026-04',[entry('2026-04',0,800,0)])]};
const held:TaxBasisEmployee={id:'c',employeeNo:'E-0450',name:'Example Employee C',status:'skipped',reason:'Held.',holdReason:'access_insufficient',recordCount:1,beforeTaxable:null,taxable:null,difference:null,beforeExempt:null,exempt:null,months:[],
 bounds:{codes:[{code:'PCB_TRA_BUSINESS',cap:6000,eligible:6400,exemptMax:6000,certainExcess:400}],months:[{payslipId:'slip-11',period:'2026-11',taxableMin:5400,exemptMax:400,items:[
  {code:'BASIC',name:'Basic salary',amount:5000,exemptionCode:null,exact:true,exemptMax:0,taxableMin:5000},
  {code:'A0080',name:'Travel Allowance',amount:800,exemptionCode:'PCB_TRA_BUSINESS',exact:false,exemptMax:400,taxableMin:400}]}]}};
const older:TaxBasisEmployee={...common,id:'d',employeeNo:'E-0460',name:'Example Employee D',status:'completed',months:[month('2026-01',null)]};

function show(locale:Locale){
 render(<NextIntlClientProvider locale={locale} messages={catalogs[locale]} timeZone="Asia/Kuala_Lumpur"><TaxBasisResults employees={[accepted,declared,held,older]}/></NextIntlClientProvider>);
 for(const details of document.querySelectorAll('details'))details.setAttribute('open','');
 return {copy:catalogs[locale].payrollTaxBasis,t:createTranslator({locale,messages:catalogs[locale],namespace:'payrollTaxBasis'})};
}
const card=(employeeNo:string)=>screen.getByText(new RegExp('^'+employeeNo+' · ')).closest('details') as HTMLElement;

describe('annual exemption limits on the recalculation results',()=>{
 it.each(Object.keys(catalogs) as Locale[])('shows limits, opening source, warning, held ranges and the PCB heading in %s',locale=>{
  const {copy,t}=show(locale);
  const a=card('E-0412'),limits=within(a).getByRole('region',{name:copy.exemptionLimitsTitle});
  expect(limits).toHaveTextContent(copy.openingSources.accepted_tp3);expect(limits).toHaveTextContent('PCB_TRA_BUSINESS');
  const summary=within(limits).getAllByRole('row')[1];
  expect(summary).toHaveTextContent('6,000.00');expect(summary).toHaveTextContent('5,500.00');expect(summary).toHaveTextContent('800.00');expect(summary).toHaveTextContent('300.00');
  expect(within(limits).getByRole('table',{name:t('monthByMonth',{code:'PCB_TRA_BUSINESS'})})).toHaveTextContent('2026-04');
  const comparison=within(a).getByRole('region',{name:copy.pcbComparisonTitle});
  expect(comparison).toHaveTextContent(copy.pcbComparisonInsufficient);expect(comparison).toHaveTextContent(copy.pcbComparisonNeverStops);expect(comparison).toHaveTextContent('1,234.50');
  expect(within(a).queryByRole('note')).toBeNull();
  const b=card('E-0433');
  expect(within(b).getByRole('note')).toHaveTextContent(copy.previousEmployerDeclaredWarning);
  expect(within(b).getByRole('region',{name:copy.exemptionLimitsTitle})).toHaveTextContent(copy.openingSources.no_accepted_tp3);
  const c=card('E-0450');
  expect(c).toHaveTextContent(copy.holdReasons.access_insufficient);
  const bounds=within(c).getByRole('region',{name:copy.boundsTitle});
  expect(bounds).toHaveTextContent(copy.boundsHelp);expect(bounds).toHaveTextContent(copy.exemptUpTo);expect(bounds).toHaveTextContent(copy.taxableAtLeast);
  expect(bounds).toHaveTextContent(t('exactValue',{value:formatMoney(5000,'MYR')}));expect(bounds).toHaveTextContent(formatMoney(400,'MYR'));
  expect(within(c).queryByRole('region',{name:copy.exemptionLimitsTitle})).toBeNull();
  expect(card('E-0460')).toHaveTextContent(copy.exemptionLimitsNotRecorded);
 });
 it('keeps every new message key and placeholder in all six catalogs',()=>{
  const keys=(value:unknown,path:string):string[]=>value&&typeof value==='object'?Object.entries(value).flatMap(([key,child])=>keys(child,path+'.'+key)):[path+'='+(typeof value==='string'&&value.trim()?(value.match(/\{\w+\}/g)??[]).join(','):'MISSING')];
  const added=['exemptionLimitsTitle','exemptionType','annualLimit','previousEmployerUsed','thisCompanyEligible','remainingLimit','taxableExcess','openingSources','previousEmployerDeclaredWarning','monthByMonth','usedBeforeMonth','remainingBefore','exemptionLimitsNotRecorded','holdReasons','boundsTitle','boundsHelp','exemptUpTo','taxableAtLeast','exactValue','pcbComparisonInsufficient','pcbComparisonNeverStops'];
  const shape=(locale:Locale)=>added.flatMap(key=>keys((catalogs[locale].payrollTaxBasis as Record<string,unknown>)[key],key));
  for(const locale of Object.keys(catalogs) as Locale[]){expect(shape(locale)).toEqual(shape('en'));expect(shape(locale).every(line=>!line.endsWith('=MISSING'))).toBe(true);}
  expect(Object.keys(en.payrollTaxBasis.holdReasons).sort()).toEqual(['access_insufficient','saved_evidence_conflict']);
  expect(Object.keys(en.payrollTaxBasis.openingSources).sort()).toEqual(['accepted_tp3','no_accepted_tp3','saved_payslip']);
 });
});
