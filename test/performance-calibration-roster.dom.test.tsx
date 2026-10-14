import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { profitCurveFor } from '../packs/performance/onehr/calibration-curve-model';
import React from 'react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/performance/onehr-actions',()=>({agreeDepartmentAction:vi.fn(),assessmentInsightAction:vi.fn(),saveCalibrationBandAction:vi.fn()}));
import { CalibrationRoster,type CalibrationRosterRow } from '../app/performance/onehr/calibration-roster';
import { assessmentInsightAction } from '../app/performance/onehr-actions';
const rows:CalibrationRosterRow[]=[['alice','Alice Tan','x','Unit X','AE'],['bob','Bob Lim','x','Unit X','ME'],['cara','Cara Lee','y','Unit Y','UA']].map(([id,name,companyId,company,performance])=>({id,name,companyId,company,performance:performance as CalibrationRosterRow['performance'],grade:'12',potential:'Mid',performanceSource:'manager',potentialSource:'manager',locked:false,potentialPct:70,journey:[{tier:'self',performance:'ME',potential:'Mid'},{tier:'manager',performance:'ME',potential:'Mid'}]}));
function show(grid=false,agree=false){render(<NextIntlClientProvider locale="en" messages={en}><CalibrationRoster sessionId="session" revision={1} agree={agree?{sessionId:'session',revision:1,axis:'performance',eligibleIds:['alice','bob']}:undefined} rows={rows} cards={rows.map(r=>({id:r.id,content:<p>{r.name} supporting review</p>}))} axes={{pm:true,pot:grid}} grid={grid} reference={{AE:20,ME:70,UA:0}}/></NextIntlClientProvider>);}
beforeEach(()=>localStorage.clear());
afterEach(cleanup);
it('keeps a dense cohort and filters the distribution, unit and person without showing every detail card',()=>{
 show();expect(screen.getByRole('columnheader',{name:en.onehr.calibrationRoster.lineManager})).toBeTruthy();expect(screen.queryByText('Alice Tan supporting review')).toBeNull();
 fireEvent.change(screen.getByLabelText(en.onehr.company),{target:{value:'x'}});expect(screen.queryByRole('button',{name:'Cara Lee'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:/^AE ·/}));expect(screen.getByRole('button',{name:'Alice Tan'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Bob Lim'})).toBeNull();
 fireEvent.change(screen.getByLabelText(en.onehr.calibrationRoster.search),{target:{value:'Nobody'}});expect(screen.getByText(en.onehr.calibrationRoster.empty)).toBeTruthy();
});
it('opens one person above the roster, pages through the filtered people and returns to the roster',()=>{
 show();fireEvent.click(screen.getByRole('button',{name:'Alice Tan'}));
 let dialog=screen.getByRole('dialog',{name:'Alice Tan'});expect(within(dialog).getByText('Alice Tan supporting review')).toBeTruthy();expect(screen.queryByText('Bob Lim supporting review')).toBeNull();
 fireEvent.click(within(dialog).getByRole('button',{name:en.onehr.calibrationRoster.next}));dialog=screen.getByRole('dialog',{name:'Bob Lim'});expect(within(dialog).getByText('Bob Lim supporting review')).toBeTruthy();
 fireEvent.click(within(dialog).getByRole('button',{name:en.onehr.calibrationRoster.close}));expect(screen.queryByRole('dialog')).toBeNull();
});
it('keeps Talent Box at nine cells, one unit at a time, with exclusive Grid and List views',()=>{
 show(true);
 expect(screen.queryByRole('combobox',{name:en.onehr.company})).toBeNull();
 expect(screen.queryByRole('button',{name:'15'})).toBeNull();
 expect(screen.queryByLabelText(en.onehr.calibrationRoster.distribution)).toBeNull();
 const box=screen.getByRole('region',{name:en.onehr.talentGrid});
 expect(within(box).getAllByRole('button',{name:/performance,/i})).toHaveLength(9);
 expect(screen.queryByRole('columnheader',{name:en.onehr.calibrationRoster.lineManager})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Unit Y'}));
 expect(within(box).queryByRole('button',{name:'Alice Tan'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.list}));
 expect(screen.queryByRole('region',{name:en.onehr.talentGrid})).toBeNull();
 expect(screen.getByRole('button',{name:'Cara Lee'})).toBeTruthy();
 expect(localStorage.getItem('performance.talent.view')).toBe('list');
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.grid}));
 expect(screen.getByRole('button',{name:'Unit Y'}).getAttribute('aria-pressed')).toBe('true');
});
it('reads a person beside the same Talent Box, returns with a last-viewed marker, and keeps unit selection',()=>{
 show(true);fireEvent.click(screen.getByRole('button',{name:'Unit Y'}));
 fireEvent.click(within(screen.getByRole('region',{name:en.onehr.talentGrid})).getByRole('button',{name:'Cara Lee'}));
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(within(screen.getByRole('region',{name:'Cara Lee'})).getByText('Cara Lee supporting review')).toBeTruthy();
 expect(screen.getByRole('region',{name:en.onehr.talentGrid})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));
 expect(screen.queryByText('Cara Lee supporting review')).toBeNull();
 expect(within(screen.getByRole('complementary',{name:en.onehr.calibrationRoster.boxPeople})).getByText(/Last viewed/)).toBeTruthy();
 expect(screen.getByRole('button',{name:'Unit Y'}).getAttribute('aria-pressed')).toBe('true');
});
it('retains List column filters when reading a person and changing views, then clears them for another unit',()=>{
 show(true);fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.list}));
 fireEvent.click(screen.getByRole('button',{name:'Name: sort and filter'}));let menu=screen.getByRole('dialog',{name:'Name: sort and filter'});
 fireEvent.change(within(menu).getByRole('textbox',{name:'Search Name values'}),{target:{value:'Alice'}});fireEvent.click(within(menu).getByRole('button',{name:'Done'}));
 expect(screen.getByText('1 of 2 people')).toBeTruthy();expect(screen.queryByRole('button',{name:'Bob Lim'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Alice Tan'}));
 expect(screen.getByText('Alice Tan supporting review')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));expect(screen.getByText('1 of 2 people')).toBeTruthy();expect(screen.queryByRole('button',{name:'Bob Lim'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.grid}));fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.list}));expect(screen.getByText('1 of 2 people')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Unit Y'}));expect(screen.getByText('1 of 1 people')).toBeTruthy();expect(screen.getByRole('button',{name:'Cara Lee'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Clear filters'})).toBeNull();
});
it('opens a review navigator target in another unit and keeps that unit selected on returning to List',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><nav><a href="#assessment-cara">Review Cara Lee</a></nav><CalibrationRoster sessionId="session" revision={1} rows={rows} cards={rows.map(r=>({id:r.id,content:<p>{r.name} supporting review</p>}))} axes={{pm:true,pot:true}} grid reference={{}}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.list}));fireEvent.click(screen.getByRole('link',{name:'Review Cara Lee'}));expect(screen.getByText('Cara Lee supporting review')).toBeTruthy();expect(screen.getByRole('button',{name:'Unit Y'}).getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));expect(screen.getByText('1 of 1 people')).toBeTruthy();expect(screen.getByRole('button',{name:'Cara Lee'})).toBeTruthy();
});
it('returns to the viewed person’s cell rather than the originally selected cell',()=>{
 show(true);fireEvent.click(within(screen.getByRole('region',{name:en.onehr.talentGrid})).getByRole('button',{name:'Alice Tan'}));
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));
 const drawer=screen.getByRole('complementary',{name:en.onehr.calibrationRoster.boxPeople});expect(within(drawer).getByRole('button',{name:'Alice Tan'})).toBeTruthy();expect(within(drawer).queryByRole('button',{name:'Bob Lim'})).toBeNull();
});
it('puts moved people first in a cell, sorts their names, and brings the last-read face into the visible three',()=>{
 const cohort=[['d','Zeta',false],['c','Gamma',true],['a','Alpha',false],['b','Beta',true]].map(([id,name,moved])=>({...rows[0],id:String(id),name:String(name),moved:Boolean(moved),performance:'AE' as const,potential:'High' as const}));
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationRoster sessionId="session" revision={1} rows={cohort} cards={cohort.map(r=>({id:r.id,content:<p>{r.name} case</p>}))} axes={{pm:true,pot:true}} grid reference={{}}/></NextIntlClientProvider>);
 const people=screen.getByRole('complementary',{name:en.onehr.calibrationRoster.boxPeople});expect(within(people).getAllByRole('button').filter(b=>!b.getAttribute('aria-label')?.startsWith('Move ')).map(b=>b.getAttribute('aria-label'))).toEqual(['Beta','Gamma','Alpha','Zeta']);
 fireEvent.click(within(people).getByRole('button',{name:'Zeta'}));fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));const grid=screen.getByRole('region',{name:en.onehr.talentGrid});expect(within(grid).getByRole('button',{name:'Zeta'})).toBeTruthy();expect(within(grid).getAllByRole('button').filter(b=>['Zeta','Beta','Gamma','Alpha'].includes(b.getAttribute('aria-label')??'')).map(b=>b.getAttribute('aria-label'))).toEqual(['Zeta','Beta','Gamma']);
});
it('opens on the first unit still to lock, filters categories without combining units and explains an empty box',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationRoster sessionId="session" revision={1} rows={rows.map(r=>({...r,locked:r.companyId==='x'}))} cards={[]} axes={{pm:true,pot:true}} grid reference={{}}/></NextIntlClientProvider>);
 expect(screen.getByRole('button',{name:'Unit Y'}).getAttribute('aria-pressed')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:'High Performance, High Potential: 0'}));
 expect(screen.getByText(en.onehr.calibrationRoster.emptyBox)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'PIP/Improvement · 1'}));
 expect(within(screen.getByRole('complementary',{name:en.onehr.calibrationRoster.boxPeople})).getByRole('button',{name:'Cara Lee'})).toBeTruthy();
});

it('selects only eligible department rows and clears selection when the population filter changes',()=>{
 show(false,true);fireEvent.click(screen.getByRole('checkbox',{name:en.onehr.calibrationRoster.selectAll}));
 expect((screen.getByRole('checkbox',{name:'Agree with the line manager for Alice Tan'}) as HTMLInputElement).checked).toBe(true);
 expect((screen.getByRole('checkbox',{name:'Agree with the line manager for Cara Lee'}) as HTMLInputElement).disabled).toBe(true);
 expect(screen.getByRole('button',{name:'Save selected (2)'})).toBeTruthy();
 fireEvent.change(screen.getByLabelText(en.onehr.company),{target:{value:'x'}});expect((screen.getByRole('button',{name:'Save selected (0)'}) as HTMLButtonElement).disabled).toBe(true);
});
it('reflects the same cached insight verdict in the roster after reading a person',async()=>{
 vi.mocked(assessmentInsightAction).mockResolvedValue({pending:false,status:'submitted',source:'plain',data:{verdict:'well_justified',paragraph:'Verified supporting records.',read:'Supporting records checked.',verdict_why:'The result matches the file.',kpis:[],discuss:[]}});
 show();fireEvent.click(screen.getByRole('button',{name:'Alice Tan'}));
 fireEvent.click(within(screen.getByRole('dialog',{name:'Alice Tan'})).getByText(en.onehr.insight.title));
 expect(await within(screen.getByRole('dialog',{name:'Alice Tan'})).findByText('Verified supporting records.')).toBeTruthy();
 expect(assessmentInsightAction).toHaveBeenCalledWith('alice','session',false);
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.close}));
 expect(within(screen.getByRole('button',{name:'Alice Tan'}).closest('tr')!).getByRole('button',{name:en.onehr.insight.verdict.well_justified})).toBeTruthy();
});

it('opens read-only axis curves for the selected unit with company figures, full population and native close behavior',()=>{
 const units=[{id:'x',name:'Unit X',profit:profitCurveFor('x',null,[{companyId:'x',achievementPct:0,revision:1}])},{id:'y',name:'Unit Y',profit:profitCurveFor('y',null,[])}];
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationRoster rows={rows} cards={rows.map(r=>({id:r.id,content:<p>{r.name} review</p>}))} axes={{pm:true,pot:true}} grid reference={{}} sessionId="session" revision={1} curves={{policy:defaultPolicy(framework),units}} unitActions={units.map(unit=>({id:unit.id,node:<span>Lock {unit.name}</span>}))}/></NextIntlClientProvider>);
 expect(screen.getByText('PBT/PAT achievement 0%')).toBeTruthy();expect(screen.getByText('Lock Unit X')).toBeTruthy();expect(screen.queryByText('Lock Unit Y')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Show Performance distribution'}));let dialog=screen.getByRole('dialog',{name:'Performance distribution — Unit X'});expect(within(dialog).getByText(/2 people against/)).toBeTruthy();expect(within(dialog).getByText(/Negatively skewed/)).toBeTruthy();expect(within(dialog).queryByRole('button',{name:/Save|Move/})).toBeNull();expect(within(dialog).getAllByRole('row')).toHaveLength(6);fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Unit Y'}));expect(screen.getByText('PBT/PAT not entered · normal curve')).toBeTruthy();expect(screen.getByText('Lock Unit Y')).toBeTruthy();expect(screen.queryByText('Lock Unit X')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Show Potential distribution'}));dialog=screen.getByRole('dialog',{name:'Potential distribution — Unit Y'});expect(within(dialog).getByText(/1 person against/)).toBeTruthy();expect(within(dialog).getAllByRole('row')).toHaveLength(4);expect(within(dialog).queryByText(/PBT/)).toBeNull();
});
