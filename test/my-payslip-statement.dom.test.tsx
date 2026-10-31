import {render,screen,within} from '@testing-library/react';
import {expect,it} from 'vitest';
import {PersonalPayslipStatement} from '../app/(app)/me/payslip/statement';
import {data,labels} from './fixtures/payslip-pdf-fixture';
import {payslipPresentationRows,type PayslipPdfData} from '../lib/payslip-pdf';
import {formatMoney,formatRate} from '../lib/money';

const money=(value:number)=>formatMoney(value,'MYR');
it('shows the PDF owner’s earning and deduction rows plus recorded context and disclosures',()=>{
 const snapshot:PayslipPdfData={...data,cycleLabel:'Fictional monthly cycle',payDate:'2026-06-30',
  employerBorne:[{label:'Fictional employer-funded employee share',amount:50}],employerBorneTotal:50,
  informationRows:[{label:'Fictional configured information field',value:'Own recorded value'},{label:'Fictional configured cycle field',value:'Fictional monthly cycle'}],
  configuredEmployerContributions:[{code:'FICTIONAL',name:'Fictional configured employer contribution',amount:25}],
  nonPayableLines:[{code:'FICTIONAL-BIK',name:'Fictional non-payable benefit',amount:100}],
 };
 render(<PersonalPayslipStatement data={snapshot} labels={labels} actions={<a href="/fictional-own-review">Review own payslip</a>}/>);
 const rows=payslipPresentationRows(snapshot,labels,value=>formatRate(value,'MYR'));
 for(const [heading,items] of [[labels.earnings,rows.earnings],[labels.deductions,rows.deductions]] as const) {
  const section=within(screen.getByRole('heading',{name:heading}).parentElement!);
  for(const row of items){expect(section.getByText(row.label)).toBeVisible();if(row.amount!=null)expect(section.getAllByText(money(row.amount)).length).toBeGreaterThan(0);}
 }
 expect(screen.getByText(/Fictional monthly cycle/)).toBeVisible();
 expect(screen.getByText(`${labels.paymentDateLabel}: ${labels.paymentDate}`)).toBeVisible();
 expect(screen.getByText('Own recorded value')).toBeVisible();
 expect(screen.getByText(labels.employerBorneTotal)).toBeVisible();
 expect(screen.getByText('Fictional configured employer contribution')).toBeVisible();
 expect(screen.getByText('Fictional non-payable benefit')).toBeVisible();
 expect(screen.getByText(labels.employerBorneNote)).toBeVisible();expect(screen.getByText(labels.nonPayableNote)).toBeVisible();
 expect(screen.getByText(labels.hrContactNote!)).toBeVisible();expect(screen.getByText(labels.periodScopeNote!)).toBeVisible();
 expect(screen.getByRole('link',{name:'Review own payslip'})).toHaveAttribute('href','/fictional-own-review');
});
it('distinguishes unrecorded employer period totals from an actual recorded zero, as the PDF does',()=>{
 const snapshot:PayslipPdfData={...data,employerPeriodTotals:{mtd:{epf:null,socso:0,eis:0,hrdf:null},ytd:{epf:null,socso:0,eis:0,hrdf:null}}};
 render(<PersonalPayslipStatement data={snapshot} labels={labels} actions={null}/>);
 const employer=within(screen.getByRole('heading',{name:labels.employerContributions}).parentElement!);
 expect(employer.getAllByText(labels.periodNotRecorded!).length).toBeGreaterThan(0);expect(employer.getAllByText(money(0)).length).toBeGreaterThan(0);
 const ytd=within(screen.getByRole('heading',{name:labels.ytdHeading}).parentElement!);
 const epf=within(ytd.getByRole('rowheader',{name:'EPF'}).parentElement!);
 expect(epf.getAllByText(labels.periodNotRecorded!)).toHaveLength(2);
 const socso=within(ytd.getByRole('rowheader',{name:'SOCSO'}).parentElement!);
 expect(socso.getByText(money(0))).toBeVisible();
});

it('keeps a hidden configured information field out of the document even when the snapshot has that value',()=>{
 render(<PersonalPayslipStatement data={{...data,cycleLabel:'Fictional hidden cycle',informationRows:[]}} labels={labels} actions={null}/>);
 expect(screen.queryByText(/Fictional hidden cycle/)).toBeNull();
});
