import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,act} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentRecordInsightAction:vi.fn()}));
import {assessmentRecordInsightAction} from '../app/(app)/performance/onehr-actions';
import {RecordInsight} from '../app/(app)/performance/onehr/record-insight';
const show=(id='current')=><NextIntlClientProvider locale="en" messages={en}><RecordInsight key={id} reviewId={id} kind="cycle"/></NextIntlClientProvider>;
beforeEach(()=>vi.mocked(assessmentRecordInsightAction).mockReset());afterEach(cleanup);
it('reads the personal cache on opening and generates only after the employee chooses to',async()=>{
 vi.mocked(assessmentRecordInsightAction).mockResolvedValueOnce({pending:true,source:null,data:null}).mockResolvedValueOnce({pending:false,source:'plain',data:{paragraph:'Your released result.'}});
 render(show());expect(await screen.findByRole('button',{name:en.onehr.insight.generate})).toBeTruthy();expect(assessmentRecordInsightAction).toHaveBeenLastCalledWith('current','cycle',false);
 fireEvent.click(screen.getByRole('button',{name:en.onehr.insight.generate}));expect(await screen.findByText('Your released result.')).toBeTruthy();expect(assessmentRecordInsightAction).toHaveBeenLastCalledWith('current','cycle',true);
});
it('discards a late summary when the selected record changes',async()=>{
 let finish!:(v:Awaited<ReturnType<typeof assessmentRecordInsightAction>>)=>void;vi.mocked(assessmentRecordInsightAction).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({pending:false,source:'plain',data:{paragraph:'Other released record.'}});
 const page=render(show());page.rerender(show('older'));expect(assessmentRecordInsightAction).toHaveBeenLastCalledWith('older','cycle',false);
 await act(async()=>finish({pending:false,source:'plain',data:{paragraph:'Old late response'}}));expect(screen.queryByText('Old late response')).toBeNull();expect(await screen.findByText('Other released record.')).toBeTruthy();
});
