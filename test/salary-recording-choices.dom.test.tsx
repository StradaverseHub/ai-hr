import {afterEach,describe,expect,it} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {SalaryAmendmentHistory} from '../components/salary-amendment-history';
import {SalaryRecordingChoices,type SalaryRecordingOptions} from '../components/salary-recording-choices';
import messages from '../messages/en.json';
afterEach(cleanup);
const options:SalaryRecordingOptions={events:[{code:'merit_award',label:'Fictional Merit Award'}],latest:[{id:'latest-a',label:'Fictional Promotion',effectiveDate:'2026-06-01',canUpdate:true,paymentMethod:'cash'},{id:'latest-b',label:'Fictional Adjustment',effectiveDate:'2026-06-01',canUpdate:true,paymentMethod:'cheque'}],closedPeriods:['2026-06']};
function mount(){return render(<NextIntlClientProvider locale="en" messages={messages}><form><input name="basicSalary" defaultValue="3500"/><SalaryRecordingChoices options={options} defaultDate="2026-07-01" paymentMethod="cash"/></form></NextIntlClientProvider>);}
describe('Salary Add/Edit recording decisions',()=>{
 it('posts the configured event, amount, method and editable date together',()=>{
  const {container}=mount(),data=new FormData(container.querySelector('form')!);
  expect(data.get('salaryRecordingChoice')).toBe('newEvent');expect(data.get('salaryMovementType')).toBe('merit_award');expect(data.get('effectiveFrom')).toBe('2026-07-01');expect(data.get('basicSalary')).toBe('3500');expect(data.get('paymentMethod')).toBe('cash');
 });
 it('requires an explicit same-day target and keeps its date and payment method visible',()=>{
  const {container}=mount();fireEvent.change(container.querySelector('select[name="salaryRecordingChoice"]')!,{target:{value:'updateLatest'}});
  const target=container.querySelector('select[name="salaryMovementId"]')!;expect(target).toBeRequired();expect(target).toHaveValue('');
  fireEvent.change(target,{target:{value:'latest-b'}});
  expect(container.querySelector('input[name="effectiveFrom"]')).toHaveValue('2026-06-01');expect(container.querySelector('input[name="effectiveFrom"]')).toHaveAttribute('readonly');
  expect(new FormData(container.querySelector('form')!).get('paymentMethod')).toBe('cheque');expect(container.querySelector('textarea[name="salaryRecordingReason"]')).toBeRequired();
  expect(screen.queryByRole('checkbox')).toBeNull();
 });
 it('explains an amendment without adding an event-type input and requires a reason',()=>{
  const {container}=mount();fireEvent.change(container.querySelector('select[name="salaryRecordingChoice"]')!,{target:{value:'amendment'}});
  expect(screen.getByText(messages.people.detail.salaryRecording.amendmentHint)).toBeInTheDocument();expect(container.querySelector('select[name="salaryMovementType"]')).toBeNull();expect(container.querySelector('textarea[name="salaryRecordingReason"]')).toBeRequired();
 });
});

describe('recorded salary amendment presentation',()=>{
 it('renders the HR business date and amount as record-only, with bounded history navigation',()=>{
  const labels={title:'Recorded salary amendments',date:'Effective date',amount:'Basic salary',rate:'Rate',payrollFrom:'Open payroll from',recordOnly:'Record only — closed payroll unchanged',reason:'Reason',previous:'Previous',next:'Next'};
  render(<SalaryAmendmentHistory rows={[{id:'fictional',compensationId:'native-reference',basicSalary:'3400.00',currency:'MYR',rateAmount:null,effectiveFrom:'2026-01-15',payrollFrom:null,until:'2026-03-01',informationOnly:true,reason:'Fictional signed salary correction'}]} page={2} hasMore href={page=>'/salary?page='+page} labels={labels}/>);
  expect(screen.getByText('3,400.00',{exact:false})).toBeInTheDocument();expect(screen.getByText(labels.recordOnly)).toBeInTheDocument();
  expect(screen.getByText('Fictional signed salary correction')).toBeInTheDocument();expect(screen.queryByText('2026-01-15')).toBeNull();
  expect(screen.getByRole('link',{name:'Previous'})).toHaveAttribute('href','/salary?page=1');expect(screen.getByRole('link',{name:'Next'})).toHaveAttribute('href','/salary?page=3');
 });
});
