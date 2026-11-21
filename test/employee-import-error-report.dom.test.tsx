/** Item 1859cce0 — the Import History error report renders every problem with its row, employee, template column,
 * wording and result, under the shipping catalogues. Board d3ba1e9f: the default view is the attempt's Error Log
 * lines (rows as Excel numbers them) and the download is the Error Log. Fictional data only. */
import {describe,expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {createTranslator,NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import zh from '../messages/zh.json';
import {employeeImportReport,type EmployeeImportReport} from '../lib/employee-import-report';
import {employeeHistoryProblemLines} from '../lib/employee-import-problems';

const catalogues={en,zh} as Record<string,typeof en>;
let locale='en';
vi.mock('next-intl/server',()=>({getTranslations:async(namespace?:string)=>createTranslator({locale,messages:catalogues[locale],namespace:namespace as never})}));
const {EmployeeImportErrorReport,ERROR_REPORT_PAGE_LINES}=await import('../app/admin/personnel/import/history/employee-import-error-report');

const plan={rows:[
 {rowNum:8,fullName:'Fictional Farah',employeeCode:'EMP-0008',companyId:'co',ok:false,errors:['a','b'],issues:[
  {column:'contract_start_date',code:'contract.required',message:'Contract Start Date is required when Employment Type is Contract.'},
  {column:'contract_end_date',code:'contract.required',message:'Contract End Date is required when Employment Type is Contract.'}]},
 {rowNum:9,fullName:'Fictional Arjun',employeeCode:'EMP-0009',companyId:'co',ok:true,errors:[]},
 {rowNum:13,fullName:'Fictional Wei',employeeCode:'EMP-0013',companyId:'co',ok:true,errors:[]},
]};
const events=[{kind:'previewed',detail:{}},{kind:'failed',detail:{message:'x',rows:[{rowNum:13,employeeCode:'EMP-0013',fullName:'Fictional Wei',companyId:'co',outcome:'stopped',column:'employee_code',message:'Employee ID "EMP-0013" is already in use'}]}}];
const problemsFor=(report:EmployeeImportReport)=>{
 const root=createTranslator({locale,messages:catalogues[locale]}),shared=createTranslator({locale,messages:catalogues[locale],namespace:'importProblems'});
 return employeeHistoryProblemLines({report,fileIssues:[]},{problems:(key,values)=>root(key as never,values as never),shared:key=>shared(key as never)});
};
async function show(showAll=false,report=employeeImportReport(plan,events)){
 return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]}>{await EmployeeImportErrorReport({attemptId:'7c41e2a9-0000-4000-8000-000000000000',report,problems:problemsFor(report),showAll,full:true})}</NextIntlClientProvider>);
}
const r=en.people.importHistory.errorReport,p=en.importProblems;

describe('EmployeeImportErrorReport',()=>{
 it('shows the counts, the cancelled-file explanation and the Error Log lines, rows as Excel numbers them',async()=>{
  locale='en';await show();
  expect(screen.getByRole('alert')).toHaveTextContent(r.cancelledTitle);
  // Data row 13 is Excel row 14 (the header is row 1).
  expect(screen.getByRole('alert')).toHaveTextContent(r.cancelledBody.replace('{rows}','14'));
  const rows=within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toHaveAttribute('data-problem-row','9');expect(rows[0]).toHaveTextContent('EMP-0008');expect(rows[0]).toHaveTextContent('Contract Start Date');
  expect(rows[0]).toHaveTextContent(r.contract.required);expect(rows[0]).toHaveTextContent(p.stage.check);expect(rows[0]).toHaveTextContent(p.result.refused);
  expect(rows[0]).toHaveTextContent(en.importErrorLogEmployee.correction.requiredForContract);
  expect(rows[1]).toHaveTextContent('Contract End Date');
  expect(rows[2]).toHaveAttribute('data-problem-row','10');expect(rows[2]).toHaveTextContent('EMP-0009');expect(rows[2]).toHaveTextContent(r.cancelledRow.replace('{rows}','14'));expect(rows[2]).toHaveTextContent(p.result.cancelled);
  expect(rows[3]).toHaveAttribute('data-problem-row','14');expect(rows[3]).toHaveTextContent('EMP-0013');expect(rows[3]).toHaveTextContent(p.stage.save);expect(rows[3]).toHaveTextContent(p.result.stopped);
  expect(screen.getByRole('link',{name:r.problemRows.replace('{count}','2')})).toHaveAttribute('aria-current','page');
  expect(screen.getByRole('link',{name:p.downloadLog})).toHaveAttribute('href','/admin/personnel/import/history/7c41e2a9-0000-4000-8000-000000000000/error-log');
  expect(screen.queryByRole('link',{name:r.download})).toBeNull();
  expect(document.body.textContent).not.toMatch(/rolled back/);
 });
 it('All rows adds the rows with no problem, saying why they were not saved',async()=>{
  locale='en';await show(true);
  const rows=within(screen.getByRole('table')).getAllByRole('row').slice(1);
  expect(rows).toHaveLength(4);
  expect(rows[0]).toHaveTextContent('9');
  expect(rows[2]).toHaveTextContent('EMP-0009');expect(rows[2]).toHaveTextContent(r.cancelledRow.replace('{rows}','14'));expect(rows[2]).toHaveTextContent(r.outcome.cancelled);
 });
 it('bounds the rendered lines and points to the Error Log for the rest',async()=>{
  locale='en';
  const many={rows:Array.from({length:ERROR_REPORT_PAGE_LINES+20},(_,i)=>({rowNum:i+1,fullName:`Fictional ${i}`,employeeCode:`F${i}`,companyId:'co',ok:false,errors:['Missing email'],issues:[{column:'email',message:'Missing email'}]}))};
  await show(false,employeeImportReport(many,[]));
  // The screen shows the first 200 Error Log lines and says how many more the file has.
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(200+1);
  expect(screen.getByText(p.moreInLog.replace('{count}',String(ERROR_REPORT_PAGE_LINES+20-200)))).toBeInTheDocument();
  await show(true,employeeImportReport(many,[]));
  expect(screen.getByText(r.truncated.replace('{shown}',String(ERROR_REPORT_PAGE_LINES)).replace('{total}',String(ERROR_REPORT_PAGE_LINES+20)))).toBeInTheDocument();
 });
 it('renders the shipping translation in another locale',async()=>{
  locale='zh';await show();
  expect(screen.getByRole('heading',{name:zh.people.importHistory.errorReport.title})).toBeInTheDocument();
  expect(screen.getAllByText(zh.people.importHistory.errorReport.contract.required).length).toBe(2);
 });
});
