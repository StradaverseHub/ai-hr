import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,act} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentTalentInsightAction:vi.fn()}));
import {assessmentTalentInsightAction} from '../app/(app)/performance/onehr-actions';
import {TalentInsight} from '../app/(app)/performance/onehr/talent-insight';
const show=(id='current')=><NextIntlClientProvider locale="en" messages={en}><TalentInsight key={id} reviewId={id} sessionId="bg"/></NextIntlClientProvider>;
beforeEach(()=>vi.mocked(assessmentTalentInsightAction).mockReset());afterEach(cleanup);
it('reads the Talent Box cache on opening and generates only after the reviewer chooses to',async()=>{
 vi.mocked(assessmentTalentInsightAction).mockResolvedValueOnce({pending:true,source:null,data:null}).mockResolvedValueOnce({pending:false,source:'plain',data:{decision:'Check the evidence.',insight:'Your released result.'}});
 render(show());expect(await screen.findByRole('button',{name:en.onehr.insight.generate})).toBeTruthy();expect(assessmentTalentInsightAction).toHaveBeenLastCalledWith('current','bg',false);
 fireEvent.click(screen.getByRole('button',{name:en.onehr.insight.generate}));expect(await screen.findByText('Your released result.')).toBeTruthy();expect(assessmentTalentInsightAction).toHaveBeenLastCalledWith('current','bg',true);
});
it('discards a late summary when the selected person changes',async()=>{
 let finish!:(v:Awaited<ReturnType<typeof assessmentTalentInsightAction>>)=>void;vi.mocked(assessmentTalentInsightAction).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce({pending:false,source:'plain',data:{decision:'Check the evidence.',insight:'Other released record.'}});
 const page=render(show());page.rerender(show('older'));expect(assessmentTalentInsightAction).toHaveBeenLastCalledWith('older','bg',false);
 await act(async()=>finish({pending:false,source:'plain',data:{decision:'Check the evidence.',insight:'Old late response'}}));expect(screen.queryByText('Old late response')).toBeNull();expect(await screen.findByText('Other released record.')).toBeTruthy();
});
