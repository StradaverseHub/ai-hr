import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it} from 'vitest';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {ProgressTable} from '../app/(app)/performance/onehr/progress-table';
import type {getAssessmentAssessorProgress,getAssessmentProgress} from '../packs/performance/service';
afterEach(cleanup);
it('opens the overview-linked assessor/company filter and can clear it without losing authorized rows',()=>{
 const assessment={cycle:{id:'cycle',name:'Cycle',status:'open'},filter:{module:'pm',state:'all'},availableModules:['pm'],counts:{},rows:[]} as unknown as Awaited<ReturnType<typeof getAssessmentProgress>>;
 const assessors=['Acme','Other'].map((company,i)=>({employmentId:String(i),name:company+' assessor',code:null,email:null,company,group:'Group',department:'Finance',lastLogin:null,assigned:2,done:i,remaining:2-i,state:i?'active':'pending'})) as Awaited<ReturnType<typeof getAssessmentAssessorProgress>>;
 render(<NextIntlClientProvider locale="en" messages={messages}><ProgressTable assessment={assessment} assessors={assessors} initial={{kind:'assessors',group:'',company:'Other'}}/></NextIntlClientProvider>);
 expect(screen.getByText('Other assessor')).toBeVisible();expect(screen.queryByText('Acme assessor')).not.toBeInTheDocument();expect(screen.getByRole('link',{name:'Export CSV'})).toHaveAttribute('href',expect.stringContaining('kind=assessors'));expect(screen.getByRole('link',{name:'Export CSV'})).toHaveAttribute('href',expect.stringContaining('company=Other'));
 fireEvent.change(screen.getByLabelText('Company'),{target:{value:''}});expect(screen.getByText('Acme assessor')).toBeVisible();
});
