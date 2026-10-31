import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentCompetencyInsightAction:vi.fn()}));
import {assessmentCompetencyInsightAction} from '../app/(app)/performance/onehr-actions';
import {CompetencyInsight} from '../app/(app)/performance/onehr/competency-insight';
afterEach(()=>{cleanup();vi.resetAllMocks();});
it('opens with a cache read and generates only when the manager asks',async()=>{
 vi.mocked(assessmentCompetencyInsightAction).mockResolvedValueOnce({status:'submitted',pending:true,source:null,data:null}).mockResolvedValueOnce({status:'submitted',pending:false,source:'plain',data:{v:2,paragraph:'Stored competency answers.',verdict:'partly_justified',verdict_why:'A short reflection.',discuss:['Discuss a specific example.']}});
 render(<NextIntlClientProvider locale="en" messages={en}><CompetencyInsight reviewId="review"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByText(en.onehr.competencyInsight.title));
 await waitFor(()=>expect(assessmentCompetencyInsightAction).toHaveBeenCalledWith('review',false));
 fireEvent.click(await screen.findByRole('button',{name:en.onehr.insight.generate}));
 expect(await screen.findByText('Stored competency answers.')).toBeTruthy();expect(assessmentCompetencyInsightAction).toHaveBeenLastCalledWith('review',true);
 expect(screen.getByText('Discuss a specific example.')).toBeTruthy();
});
