import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const {load}=vi.hoisted(()=>({load:vi.fn()}));
vi.mock('../app/admin/attendance/approval-workflow/actions',()=>({attendanceWorkflowWarningPageAction:load}));
import {WorkflowWarnings} from '../app/admin/attendance/approval-workflow/workflow-warnings';
const row={employmentId:'employee',employeeCode:'EMP-0005',name:'Fictional employee',companyId:'company',levelIndex:0,problem:{code:'missing_superior' as const,levelIndex:0},legacy:false};
beforeEach(()=>{vi.clearAllMocks();});afterEach(cleanup);
it('confirms persistence separately from readiness and offers non-blocking details',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><WorkflowWarnings lineageId="lineage" initial={{rows:[row],total:1,offset:0,hasMore:false}} saved/></NextIntlClientProvider>);
 expect(screen.getByRole('status')).toHaveTextContent(en.attendanceWorkflow.savedWithWarnings);
 expect(screen.getByRole('link',{name:'Review details (1)'})).toHaveAttribute('href','#workflow-warnings');
 expect(screen.getByRole('cell',{name:'EMP-0005'})).toBeVisible();expect(screen.getByRole('cell',{name:'Fictional employee'})).toBeVisible();
 expect(screen.getByRole('cell',{name:'Level 1'})).toBeVisible();
 fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));expect(screen.queryByRole('status')).toBeNull();
 expect(screen.getByRole('cell',{name:'EMP-0005'})).toBeVisible();
});
it('loads subsequent employee warning pages and preserves the current page after failure',async()=>{
 load.mockResolvedValueOnce({ok:true,page:{rows:[{...row,employeeCode:'EMP-0051'}],total:51,offset:50,hasMore:false}}).mockResolvedValueOnce({ok:false,error:'Unable to read warnings.'});
 render(<NextIntlClientProvider locale="en" messages={en}><WorkflowWarnings lineageId="lineage" initial={{rows:[row],total:51,offset:0,hasMore:true}} saved={false}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:en.attendanceWorkflow.nextEmployees}));
 expect(await screen.findByRole('cell',{name:'EMP-0051'})).toBeVisible();expect(load).toHaveBeenCalledWith('lineage',50);
 fireEvent.click(screen.getByRole('button',{name:en.attendanceWorkflow.previousEmployees}));
 expect(await screen.findByRole('alert')).toHaveTextContent('Unable to read warnings.');
 await waitFor(()=>expect(screen.getByRole('cell',{name:'EMP-0051'})).toBeVisible());
});
