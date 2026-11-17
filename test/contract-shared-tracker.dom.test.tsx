import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import type {ComponentProps} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {SharedContractTracker} from '../app/lifecycle/contracts/shared-tracker';
vi.mock('next/navigation',()=>({usePathname:()=>'/lifecycle/contracts'}));
afterEach(cleanup);

it.each(['scheduled','awaiting_application'] as const)('keeps current Personnel facts distinct from an approved next period: %s',status=>{
 const page:ComponentProps<typeof SharedContractTracker>['page']={
  rows:[{id:'employment',employmentId:'employment',caseId:'case',caseNumber:'CT-41',companyId:'company',employeeName:'Fictional period employee',employeeCode:'F-41',company:'Fictional Company',businessGroup:'Fictional Group',department:'Operations',position:'Specialist',manager:'Fictional manager',startOn:'2026-01-01',endOn:'2026-12-31',contractNumber:4,sourceRevision:null,stage:'renewed',legacyState:'renewed',sharedRevision:12,flags:[],attention:false,lastActivityAt:null,payChanges:false,payConfirmed:false,previousPayPending:false,payPendingCaseId:null,canOpen:false,sourceIssue:null,firstReminderOn:null,decisionNeeded:false,endPassed:false,stalledDays:null,
   scheduledPeriod:{postingId:'posting',label:'PP-42',eventType:'contractRenewal',startOn:'2027-01-01',endOn:'2027-12-31',contractNumber:5,status}}],
  total:1,summary:{total:1,upcoming:0,decision:0,inProgress:0,closed:1,attention:0},companies:[{id:'company',name:'Fictional Company'}],businessGroups:[],hasMore:false,limit:50,offset:0,
 };
 render(<NextIntlClientProvider locale="en" messages={en}><SharedContractTracker page={page} query={{}} waiting={[]}/></NextIntlClientProvider>);
 const employee=within(screen.getByRole('row',{name:/Fictional period employee/}));
 const period=employee.getAllByRole('cell')[2];
 expect(period).toHaveTextContent('Contract #4');
 expect(period).toHaveTextContent('01/01/2026–31/12/2026');
 expect(period).toHaveTextContent('Contract #5');
 expect(period).toHaveTextContent('01/01/2027–31/12/2027');
 expect(employee.getByRole('link',{name:status==='scheduled'?'Approved next period · Scheduled':'Approved next period · Awaiting Personnel application'})).toHaveAttribute('href','/lifecycle/contracts/case');
 expect(employee.queryByRole('link',{name:'View period'})).not.toBeInTheDocument();
});
