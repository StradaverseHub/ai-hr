import React from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({load:vi.fn()}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({assessmentInsightAction:ports.load}));
import { PerformanceInsight } from '../app/(app)/performance/onehr/performance-insight';
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('ignores an older response that arrives after a reopened view has lost access',async()=>{
 let resolveOld!:(value:unknown)=>void;ports.load.mockImplementationOnce(()=>new Promise(resolve=>{resolveOld=resolve;})).mockResolvedValueOnce({error:'Assessment is no longer assigned.'});
 render(<NextIntlClientProvider locale="en" messages={en}><PerformanceInsight reviewId="review"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByText(en.onehr.insight.title));await waitFor(()=>expect(ports.load).toHaveBeenCalledOnce());
 fireEvent.click(screen.getByText(en.onehr.insight.title));fireEvent.click(screen.getByText(en.onehr.insight.title));await waitFor(()=>expect(ports.load).toHaveBeenCalledTimes(2));
 resolveOld({status:'submitted',pending:false,source:'plain',data:{verdict:'partly_justified',paragraph:'Older authorized view.',kpis:[],discuss:[]}});
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Assessment is no longer assigned.');expect(screen.queryByText('Older authorized view.')).toBeNull();
});
it('opens with a cache-only request and generates only after an explicit action in the calibration context',async()=>{
 ports.load.mockResolvedValueOnce({status:'submitted',pending:true,source:null,data:null}).mockResolvedValueOnce({status:'submitted',pending:false,source:'plain',data:{verdict:'not_justified',paragraph:'The result has no supporting file.',kpis:[],discuss:['Ask for evidence before deciding.']}});
 render(<NextIntlClientProvider locale="en" messages={en}><PerformanceInsight reviewId="review" contextId="calibration"/></NextIntlClientProvider>);
 expect(ports.load).not.toHaveBeenCalled();fireEvent.click(screen.getByText(en.onehr.insight.title));
 await waitFor(()=>expect(ports.load).toHaveBeenCalledWith('review','calibration',false));
 fireEvent.click(await screen.findByRole('button',{name:en.onehr.insight.generate}));
 await waitFor(()=>expect(ports.load).toHaveBeenCalledWith('review','calibration',true));
 expect(await screen.findByText(en.onehr.insight.verdict.not_justified)).toBeTruthy();expect(screen.getByText('Ask for evidence before deciding.')).toBeTruthy();
 expect(screen.queryByRole('button',{name:en.onehr.insight.generate})).toBeNull();
});
it('clears a previously displayed insight and reports the access failure when reopened after revocation',async()=>{
 ports.load.mockResolvedValueOnce({status:'submitted',pending:false,source:'plain',data:{verdict:'partly_justified',paragraph:'Previously authorized view.',kpis:[],discuss:[]}}).mockResolvedValueOnce({error:'Assessment is no longer assigned.'});
 render(<NextIntlClientProvider locale="en" messages={en}><PerformanceInsight reviewId="review"/></NextIntlClientProvider>);
 fireEvent.click(screen.getByText(en.onehr.insight.title));expect(await screen.findByText('Previously authorized view.')).toBeTruthy();
 fireEvent.click(screen.getByText(en.onehr.insight.title));fireEvent.click(screen.getByText(en.onehr.insight.title));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','Assessment is no longer assigned.');expect(screen.queryByText('Previously authorized view.')).toBeNull();
});
it('opens a requested list insight with a cache-only read and still lets the person close it',async()=>{
 ports.load.mockResolvedValue({status:'submitted',pending:true,source:null,data:null});
 render(<NextIntlClientProvider locale="en" messages={en}><PerformanceInsight reviewId="review" contextId="calibration" initialOpen/></NextIntlClientProvider>);
 await waitFor(()=>expect(ports.load).toHaveBeenCalledExactlyOnceWith('review','calibration',false));expect(await screen.findByRole('button',{name:en.onehr.insight.generate})).toBeTruthy();
 const summary=screen.getByText(en.onehr.insight.title),details=summary.closest('details')!;expect(details.open).toBe(true);
 fireEvent.click(summary);await waitFor(()=>expect(details.open).toBe(false));expect(ports.load).toHaveBeenCalledOnce();
});
