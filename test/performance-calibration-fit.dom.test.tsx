import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({previewCalibrationFitAction:vi.fn(),applyCalibrationFitAction:vi.fn()}));
vi.mock('../app/(app)/performance/onehr/draft-form',()=>({flushAssessmentDrafts:vi.fn().mockResolvedValue(undefined)}));
import {previewCalibrationFitAction,applyCalibrationFitAction} from '../app/(app)/performance/onehr-actions';
import {flushAssessmentDrafts} from '../app/(app)/performance/onehr/draft-form';
import {CalibrationFit} from '../app/(app)/performance/onehr/calibration-fit';
const preview={sessionId:'session',axis:'performance' as const,companyId:'unit',revision:2,moves:[{id:'review',name:'Nadia',from:'OU' as const,to:'AE' as const,direction:'down' as const,reasons:['Lowest score in Outstanding.']}],withinAfter:true,unscored:['Siti']};
beforeEach(()=>{vi.mocked(previewCalibrationFitAction).mockReset().mockResolvedValue(preview);vi.mocked(applyCalibrationFitAction).mockReset().mockResolvedValue({applied:['review'],skipped:[],revision:3});vi.mocked(flushAssessmentDrafts).mockReset().mockResolvedValue(undefined);});afterEach(cleanup);
const show=()=>render(<NextIntlClientProvider locale="en" messages={en}><CalibrationFit sessionId="session" axis="performance" companyId="unit"/></NextIntlClientProvider>);
it('shows the suggested moves without writing and applies only displayed identities and bands',async()=>{
 show();expect(previewCalibrationFitAction).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Preview curve fit'}));expect(await screen.findByText('Nadia')).toBeTruthy();expect(screen.getByText(/Siti.*remain/)).toBeTruthy();expect(applyCalibrationFitAction).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Apply 1 move'}));expect(await screen.findByText('Applied 1 move; skipped 0 changed or unavailable records.')).toBeTruthy();expect(applyCalibrationFitAction).toHaveBeenCalledWith('session','performance','unit',[{id:'review',from:'OU',to:'AE'}]);expect(flushAssessmentDrafts).toHaveBeenCalledTimes(2);expect(screen.queryByRole('button',{name:'Apply 1 move'})).toBeNull();
});
it('refuses preview after a failed remark save and displays an apply rejection without changing its suggestions',async()=>{
 vi.mocked(flushAssessmentDrafts).mockRejectedValueOnce(Error('save failed'));show();fireEvent.click(screen.getByRole('button',{name:'Preview curve fit'}));expect((await screen.findByRole('alert')).textContent).toContain('Could not complete');expect(previewCalibrationFitAction).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Close'}));
 fireEvent.click(screen.getByRole('button',{name:'Preview curve fit'}));await screen.findByText('Nadia');vi.mocked(applyCalibrationFitAction).mockResolvedValueOnce({error:'This calibration is locked.'});fireEvent.click(screen.getByRole('button',{name:'Apply 1 move'}));expect((await screen.findByRole('alert')).textContent).toContain('This calibration is locked.');expect(screen.getByText('Nadia')).toBeTruthy();
});
