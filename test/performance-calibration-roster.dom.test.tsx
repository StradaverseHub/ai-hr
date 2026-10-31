import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { profitCurveFor } from '../packs/performance/onehr/calibration-curve-model';
import React from 'react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({agreeDepartmentAction:vi.fn(),assessmentInsightAction:vi.fn(),saveCalibrationBandAction:vi.fn()}));
import { CalibrationRoster,type CalibrationRosterRow } from '../app/(app)/performance/onehr/calibration-roster';
import { assessmentInsightAction } from '../app/(app)/performance/onehr-actions';
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
const board=()=>screen.getByRole('region',{name:en.onehr.talentBoard.title});
const cells=()=>within(board()).getAllByRole('group').filter(g=>g.hasAttribute('data-board-cell'));
it('replaces the count grid with the nine-cell board, a whole-scope unit row and exclusive 9-box, Table and category views',()=>{
 show(true);
 expect(screen.queryByRole('combobox',{name:en.onehr.company})).toBeNull();
 expect(screen.queryByLabelText(en.onehr.calibrationRoster.distribution)).toBeNull();
 expect(cells()).toHaveLength(9);
 expect(screen.getByRole('button',{name:'All 3'}).getAttribute('aria-pressed')).toBe('true');
 expect(within(board()).getByRole('button',{name:'Cara Lee'})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Unit Y 1'}));
 expect(within(board()).queryByRole('button',{name:'Alice Tan'})).toBeNull();expect(screen.getByText('1 person')).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:en.onehr.talentBoard.table}));
 expect(screen.queryByRole('group',{name:/Solid Core, High potential/})).toBeNull();
 expect(screen.getByRole('button',{name:'Cara Lee'})).toBeTruthy();expect(screen.getByText('1 of 1 people')).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'PIP/Improvement 1'}));
 expect(screen.getByRole('region',{name:'PIP/Improvement'})).toBeTruthy();expect(screen.getByRole('button',{name:'Cara Lee'})).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:'Star 0'}));expect(screen.getByText('No one here is in Star right now.')).toBeTruthy();
 fireEvent.click(screen.getByRole('tab',{name:en.onehr.talentBoard.grid9}));
 expect(screen.getByRole('button',{name:'Unit Y 1'}).getAttribute('aria-pressed')).toBe('true');
});
it('reads a person in place of the board and returns to the same unit',()=>{
 show(true);fireEvent.click(screen.getByRole('button',{name:'Unit Y 1'}));
 fireEvent.click(within(board()).getByRole('button',{name:'Cara Lee'}));
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(within(screen.getByRole('region',{name:'Cara Lee'})).getByText('Cara Lee supporting review')).toBeTruthy();
 expect(screen.queryByRole('region',{name:en.onehr.talentBoard.title})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));
 expect(screen.queryByText('Cara Lee supporting review')).toBeNull();
 expect(screen.getByRole('button',{name:'Unit Y 1'}).getAttribute('aria-pressed')).toBe('true');
});
it('retains Table column filters when reading a person',()=>{
 show(true);fireEvent.click(screen.getByRole('tab',{name:en.onehr.talentBoard.table}));
 fireEvent.click(screen.getByRole('button',{name:'Name: sort and filter'}));const menu=screen.getByRole('dialog',{name:'Name: sort and filter'});
 fireEvent.change(within(menu).getByRole('textbox',{name:'Search Name values'}),{target:{value:'Alice'}});fireEvent.click(within(menu).getByRole('button',{name:'Done'}));
 expect(screen.getByText('1 of 3 people')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Alice Tan'}));
 expect(screen.getByText('Alice Tan supporting review')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));
 expect(screen.getByText('1 of 3 people')).toBeTruthy();expect(screen.queryByRole('button',{name:'Bob Lim'})).toBeNull();
});
it('opens a review navigator target from the board',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><nav><a href="#assessment-cara">Review Cara Lee</a></nav><CalibrationRoster sessionId="session" revision={1} rows={rows} cards={rows.map(r=>({id:r.id,content:<p>{r.name} supporting review</p>}))} axes={{pm:true,pot:true}} grid reference={{}}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('link',{name:'Review Cara Lee'}));expect(screen.getByText('Cara Lee supporting review')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));expect(screen.getByRole('region',{name:en.onehr.talentBoard.title})).toBeTruthy();
});
it('puts people moved this calibration first in their cell with the direction of the move',()=>{
 const cohort=[['d','Zeta',null],['c','Gamma','ME'],['a','Alpha',null],['b','Beta','ME']].map(([id,name,from])=>({...rows[0],id:String(id),name:String(name),from:from?{performance:'ME' as const,potential:'Mid' as const}:null,performance:'AE' as const,potential:'High' as const}));
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationRoster sessionId="session" revision={1} rows={cohort} cards={[]} axes={{pm:true,pot:true}} grid reference={{}}/></NextIntlClientProvider>);
 const cell=screen.getByRole('group',{name:/^Super Star, High potential/});
 expect(within(cell).getAllByRole('button').map(b=>b.textContent)).toEqual(['Beta','Gamma','Alpha','Zeta']);
 expect(within(cell).getAllByText('Moved up from Solid Core')).toHaveLength(2);
});
it('shows the selected unit’s curves and profit figure beside the filters and its own lock in the footer',()=>{
 const units=[{id:'x',name:'Unit X',profit:profitCurveFor('x',null,[{companyId:'x',achievementPct:0,revision:1}])},{id:'y',name:'Unit Y',profit:profitCurveFor('y',null,[])}];
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationRoster rows={rows} cards={rows.map(r=>({id:r.id,content:<p>{r.name} review</p>}))} axes={{pm:true,pot:true}} grid reference={{}} sessionId="session" revision={1} curves={{policy:defaultPolicy(framework),units}} unitActions={units.map(unit=>({id:unit.id,node:<span>Lock {unit.name}</span>}))}/></NextIntlClientProvider>);
 expect(screen.getByText(en.onehr.talentBoard.pickUnitToLock)).toBeTruthy();expect(screen.queryByText('Lock Unit X')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Unit X 2'}));
 expect(screen.getByText('PBT/PAT achievement 0%')).toBeTruthy();expect(screen.getByText('Lock Unit X')).toBeTruthy();expect(screen.queryByText('Lock Unit Y')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Show Performance distribution'}));let dialog=screen.getByRole('dialog',{name:'Performance distribution — Unit X'});expect(within(dialog).getByText(/2 people against/)).toBeTruthy();expect(within(dialog).getByText(/Negatively skewed/)).toBeTruthy();expect(within(dialog).queryByRole('button',{name:/Save|Move/})).toBeNull();fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Unit Y 1'}));expect(screen.getByText('PBT/PAT not entered · normal curve')).toBeTruthy();expect(screen.getByText('Lock Unit Y')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Show Potential distribution'}));dialog=screen.getByRole('dialog',{name:'Potential distribution — Unit Y'});expect(within(dialog).getByText(/1 person against/)).toBeTruthy();
});
it('opens the requested person when chat navigates into the Talent Box',()=>{
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationRoster sessionId="session" revision={1} initialFocus="cara" rows={rows} cards={rows.map(r=>({id:r.id,content:<p>{r.name} supporting review</p>}))} axes={{pm:true,pot:true}} grid reference={{}}/></NextIntlClientProvider>);
 expect(screen.getByText('Cara Lee supporting review')).toBeTruthy();expect(screen.queryByText('Alice Tan supporting review')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.calibrationRoster.backToBox}));expect(screen.getByRole('button',{name:'Unit Y 1'}).getAttribute('aria-pressed')).toBe('true');
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
