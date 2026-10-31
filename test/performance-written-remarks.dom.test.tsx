import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,act} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentWrittenRemarksAction:vi.fn()}));
import {assessmentWrittenRemarksAction} from '../app/(app)/performance/onehr-actions';
import {WrittenRemarks} from '../app/(app)/performance/onehr/written-remarks';
const entries=[{role:'self' as const,who:'Their own remark',on:null,move:null,text:'I completed service requests.'}];
const show=(id='nadia')=><NextIntlClientProvider locale="en" messages={en}><WrittenRemarks key={id} reviewId={id} sessionId="cohort" axis="pot"/></NextIntlClientProvider>;
beforeEach(()=>vi.mocked(assessmentWrittenRemarksAction).mockReset());afterEach(cleanup);
it('loads full remarks without generating and only generates a summary after the explicit click',async()=>{
 vi.mocked(assessmentWrittenRemarksAction).mockResolvedValueOnce({entries,pending:true,source:null,data:null}).mockResolvedValueOnce({entries,pending:false,source:'plain',data:{paragraph:'They wrote about completed service requests.'}});
 render(show());expect(assessmentWrittenRemarksAction).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:en.onehr.writtenRemarks.read}));
 expect(await screen.findByText(entries[0].text)).toBeTruthy();expect(assessmentWrittenRemarksAction).toHaveBeenLastCalledWith('nadia','cohort','pot',false);
 fireEvent.click(await screen.findByRole('button',{name:en.onehr.insight.generate}));expect(await screen.findByText('They wrote about completed service requests.')).toBeTruthy();expect(assessmentWrittenRemarksAction).toHaveBeenLastCalledWith('nadia','cohort','pot',true);
});
it('does not display a late response for a previous person after navigating to another person',async()=>{
 let finish!:(v:Awaited<ReturnType<typeof assessmentWrittenRemarksAction>>)=>void;vi.mocked(assessmentWrittenRemarksAction).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const page=render(show());fireEvent.click(screen.getByRole('button',{name:en.onehr.writtenRemarks.read}));page.rerender(show('siti'));
 await act(async()=>finish({entries,pending:false,source:'plain',data:{paragraph:'Nadia summary'}}));expect(screen.queryByText(entries[0].text)).toBeNull();expect(screen.queryByText('Nadia summary')).toBeNull();expect(screen.getByRole('button',{name:en.onehr.writtenRemarks.read})).toBeTruthy();
});
