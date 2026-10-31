/** Actual Chromium controls/CSS and canonical pure mappers; all records are private synthetic fixtures. */
import {useState} from 'react';
import {afterEach,describe,expect,it} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import '../app/globals.css';
import '../app/atelier.css';
import messages from '../messages/en.json';
import {EpfElection} from '../components/epf-election';
import {clientPackFor} from '../localization/registry.client';
import {mapEpfUiMode} from '../lib/epf-mode-map';
import {resolveEpfElection} from '../localization/my/epf-election';
import {HistoryGrid} from '../app/(app)/payroll/transaction-view/history-grid';
import {pivotHistoryGrid} from '../app/(app)/payroll/transaction-view/history-pivot';
import type {ProcessedPayslipViewRow} from '../core/payroll-view';
const displayRate=clientPackFor('MY')!.payroll.epfRateToPercent!;
afterEach(async()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');document.body.style.margin='';await page.viewport(1280,720);});
function mount(node:React.ReactNode){document.documentElement.setAttribute('data-ui-theme','atelier');document.body.style.margin='0';render(<NextIntlClientProvider locale="en" messages={messages}><main className="mx-auto max-w-6xl space-y-4 p-4">{node}</main></NextIntlClientProvider>);return document.querySelector('main')!;}
function EpfFixture(){
 const [saved,setSaved]=useState(()=>resolveEpfElection(mapEpfUiMode('auto',null,null))),[revision,setRevision]=useState(0);
 return <><h1 className="text-lg font-semibold">Fictional Personnel EPF election</h1><form key={revision} className="grid max-w-xl gap-4" onSubmit={event=>{event.preventDefault();const data=new FormData(event.currentTarget);setSaved(resolveEpfElection(mapEpfUiMode(String(data.get('epfMode')),String(data.get('epfEmployeeRate')),String(data.get('epfEmployerRate')))));setRevision(value=>value+1);}}>
  <EpfElection mode={saved.epfMode} employeeRate={displayRate(saved.epfEmployeeRate)} employerRate={displayRate(saved.epfEmployerRate)} employeeAmount={null} employerAmount={null} manualReason={null}/><button type="submit">Save and reopen fixture</button>
 </form><output aria-label="Persisted fixture rates">{revision} · {saved.epfEmployeeRate} · {saved.epfEmployerRate}</output></>;
}
function slip(amount:string,month:string,companyId='company-a',company='Fictional company A',runType:ProcessedPayslipViewRow['runType']='regular'):ProcessedPayslipViewRow{
 return {id:`${companyId}-${month}`,employmentId:'fixture-employee',employeeName:'Fictional employee',employeeCode:'E001',companyId,company,payPeriod:`2026-${month}`,runType,runSeq:1,batchStatus:'processed',releasedAt:null,version:1,basic:'3000.00',allowance:'0.00',overtime:amount,bonus:'0.00',gross:String(3000+Number(amount)),statutory:{epfEmployee:330,componentLines:[{code:'OT1_5',name:'Overtime 1.5',amount:Number(amount),buckets:[{bucket:'ot',amount:Number(amount)}]}]},otherDeductions:'0.00',totalDeductions:'330.00',net:String(2670+Number(amount))};
}
async function capture(name:string,element:Element){
 const width=window.innerWidth;await page.viewport(width,Math.ceil(element.scrollHeight+32));window.scrollTo(0,0);await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
 const wrapper=window.frameElement?.parentElement,style=wrapper?.getAttribute('style'),scale=wrapper?.getAttribute('data-scale');wrapper?.style.setProperty('transform','none','important');wrapper?.setAttribute('data-scale','1');
 try{const shot=await page.screenshot({element,path:`../scratchpad/payroll-browser/${name}.png`,animations:'disabled',scale:'css',base64:true,style:'#vitest-tester [data-scale], #tester-ui [data-scale] { transform: none !important; }'});const bytes=Uint8Array.from(atob(shot.base64),char=>char.charCodeAt(0)),header=new DataView(bytes.buffer);expect(header.getUint32(16)).toBe(Math.round(element.getBoundingClientRect().width));expect(header.getUint32(20)).toBeGreaterThanOrEqual(Math.floor(element.getBoundingClientRect().height)-1);}finally{if(wrapper){if(style==null)wrapper.removeAttribute('style');else wrapper.setAttribute('style',style);if(scale==null)wrapper.removeAttribute('data-scale');else wrapper.setAttribute('data-scale',scale);}}
}
for(const width of [390,1280])describe(`approved payroll displays at ${width}px`,()=>{
 it('saves and reopens actual manual EPF controls three times without losing 14 or 14.01 percent',async()=>{
  await page.viewport(width,1000);const main=mount(<EpfFixture/>);let revision=0;
  for(const value of ['14','14.01']){
   await page.getByRole('combobox').selectOptions('manual_percentage');
   await page.getByRole('spinbutton',{name:/Employee/}).fill(value);await page.getByRole('spinbutton',{name:/Employer/}).fill(value);
   for(let round=0;round<3;round++){
    await page.getByRole('button',{name:'Save and reopen fixture'}).click();revision++;
    const employee=document.querySelector<HTMLInputElement>('input[name="epfEmployeeRate"]')!,employer=document.querySelector<HTMLInputElement>('input[name="epfEmployerRate"]')!;
    expect(employee.value).toBe(value);expect(employer.value).toBe(value);expect(employee.checkValidity()).toBe(true);expect(employer.checkValidity()).toBe(true);
    expect(screen.getByLabelText('Persisted fixture rates').textContent).toBe(`${revision} · ${(Number(value)/100).toFixed(4)} · ${(Number(value)/100).toFixed(4)}`);
   }
   await capture(`epf-${value}-${width}`,main);
  }
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);
 });
 it('places exact two-month OT totals under Summary with separate employer/cycle rows and working zero filters',async()=>{
  await page.viewport(width,1000);const grid=pivotHistoryGrid({rows:[slip('50.00','08'),slip('25.00','09'),slip('7.00','08','company-b','Fictional company B','bonus'),slip('0.00','08','company-zero','Fictional zero company')],year:2026,months:[8,9]});
  const main=mount(<HistoryGrid {...grid} monthLabels={['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']} cycleLabels={{regular:'Monthly',bonus:'Bonus'}} exportParams={{}}/>);
  const summary=screen.getByText('Summary').closest('tr')!,rows=Array.from(main.querySelectorAll('tbody tr'));
  const totals=screen.getAllByText('Total Overtime').map(label=>label.closest('tr')!);
  expect(totals).toHaveLength(2);
  const totalA=totals.find(row=>within(row).queryByText('Fictional company A'))!,totalB=totals.find(row=>within(row).queryByText('Fictional company B'))!;
  expect(Array.from(totalA.querySelectorAll('td')).slice(-3).map(cell=>cell.textContent)).toEqual(['50.00','25.00','75.00']);
  expect(Array.from(totalB.querySelectorAll('td')).slice(-3).map(cell=>cell.textContent)).toEqual(['7.00','0.00','7.00']);
  expect(within(totalA).getByText('Monthly')).toBeTruthy();expect(within(totalB).getByText('Bonus')).toBeTruthy();
  for(const detail of screen.getAllByText('Overtime 1.5'))expect(rows.indexOf(detail.closest('tr')!)).toBeLessThan(rows.indexOf(summary));
  for(const total of totals)expect(rows.indexOf(total)).toBeGreaterThan(rows.indexOf(summary));
  expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth);await capture(`overtime-summary-${width}`,main);
  await page.getByRole('checkbox',{name:/Hide.*zero/i}).click();
  const zero=screen.getAllByText('Total Overtime').map(label=>label.closest('tr')!).find(row=>within(row).queryByText('Fictional zero company'))!;
  expect(Array.from(zero.querySelectorAll('td')).slice(-3).map(cell=>cell.textContent)).toEqual(['0.00','0.00','0.00']);
  await page.getByRole('checkbox',{name:/Hide system codes/i}).click();expect(screen.queryByText('Total Overtime')).toBeNull();expect(screen.getAllByText('Overtime 1.5').length).toBeGreaterThan(0);
 });
});
