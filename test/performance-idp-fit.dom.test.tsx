import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentIdpFitAction:vi.fn()}));
vi.mock('../app/(app)/performance/onehr/draft-form',()=>({flushAssessmentDrafts:vi.fn().mockResolvedValue(undefined)}));
import {assessmentIdpFitAction} from '../app/(app)/performance/onehr-actions';
import {flushAssessmentDrafts} from '../app/(app)/performance/onehr/draft-form';
import {IdpFitInsight} from '../app/(app)/performance/onehr/idp-fit-insight';
afterEach(()=>{cleanup();vi.clearAllMocks();vi.mocked(assessmentIdpFitAction).mockReset();});
it('flushes private edits, reads cache first, and generates only on request',async()=>{
 vi.mocked(assessmentIdpFitAction).mockResolvedValueOnce({status:'shared',canGenerate:true,pending:true,source:null,data:null}).mockResolvedValueOnce({status:'shared',canGenerate:true,pending:false,source:'plain',data:{v:2,kind:'idp_fit',verdict:'partly_fits',verdict_why:'Missing direction.',paragraph:'Their plan has one goal.',scores:'Competency: their view High → your review Low',discuss:['Discuss their direction.']}});
 render(<NextIntlClientProvider locale="en" messages={en}><IdpFitInsight reviewId="review"/></NextIntlClientProvider>);fireEvent.click(screen.getByText(en.onehr.idpFit.title));
 await waitFor(()=>expect(assessmentIdpFitAction).toHaveBeenCalledWith('review',false,undefined));expect(flushAssessmentDrafts).toHaveBeenCalledTimes(1);
 fireEvent.click(await screen.findByRole('button',{name:en.onehr.insight.generate}));expect(await screen.findByText('Missing direction.')).toBeTruthy();expect(flushAssessmentDrafts).toHaveBeenCalledTimes(2);expect(screen.getByText(/your review Low/)).toBeTruthy();
});
it('has no generate action for an approver reading saved figures or a private plan',async()=>{
 vi.mocked(assessmentIdpFitAction).mockResolvedValue({status:'none',canGenerate:false,pending:false,source:null,data:null});
 render(<NextIntlClientProvider locale="en" messages={en}><IdpFitInsight reviewId="review"/></NextIntlClientProvider>);fireEvent.click(screen.getByText(en.onehr.idpFit.title));expect(await screen.findByText(en.onehr.idpFit.none)).toBeTruthy();expect(screen.queryByRole('button',{name:en.onehr.insight.generate})).toBeNull();
});
