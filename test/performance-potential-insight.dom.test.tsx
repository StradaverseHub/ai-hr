import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentPotentialInsightAction:vi.fn()}));
import {assessmentPotentialInsightAction} from '../app/(app)/performance/onehr-actions';
import {PotentialInsight} from '../app/(app)/performance/onehr/potential-insight';
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('reads the scoped cache first and generates only on request',async()=>{
 vi.mocked(assessmentPotentialInsightAction).mockResolvedValueOnce({pending:true,source:null,data:null}).mockResolvedValueOnce({pending:false,source:'plain',data:{paragraph:'Stored anonymous themes.'}});
 render(<NextIntlClientProvider locale="en" messages={en}><PotentialInsight reviewId="review" sessionId="cohort"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByText(en.onehr.potentialInsight.title));await waitFor(()=>expect(assessmentPotentialInsightAction).toHaveBeenCalledWith('review','cohort',false));fireEvent.click(await screen.findByRole('button',{name:en.onehr.insight.generate}));expect(await screen.findByText('Stored anonymous themes.')).toBeTruthy();expect(assessmentPotentialInsightAction).toHaveBeenLastCalledWith('review','cohort',true);
});
it('shows the threshold message without offering generation',async()=>{
 vi.mocked(assessmentPotentialInsightAction).mockResolvedValue({pending:false,source:'plain',data:{paragraph:'Not enough feedback yet.'}});
 render(<NextIntlClientProvider locale="en" messages={en}><PotentialInsight reviewId="review" sessionId="cohort"/></NextIntlClientProvider>);fireEvent.click(screen.getByText(en.onehr.potentialInsight.title));expect(await screen.findByText('Not enough feedback yet.')).toBeTruthy();expect(screen.queryByRole('button',{name:en.onehr.insight.generate})).toBeNull();
});
