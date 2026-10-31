import { useState } from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { TalentList } from '../app/(app)/performance/onehr/talent-list';
import type { CalibrationRosterRow } from '../app/(app)/performance/onehr/calibration-roster';
import type { TalentListFilters,TalentListSort } from '../packs/performance/onehr/talent-list-model';
const ports=vi.hoisted(()=>({save:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({saveCalibrationBandAction:ports.save}));
import { CalibrationBandForm } from '../app/(app)/performance/onehr/calibration-band-form';
import { TalentBoxMove } from '../app/(app)/performance/onehr/talent-box-move';
import { TalentBandHistory } from '../app/(app)/performance/onehr/talent-band-history';
const people:CalibrationRosterRow[]=[
 {id:'a',name:'Alice Tan',department:'Finance',grade:'12',performance:'AE',potential:'High'},
 {id:'b',name:'Bob Lim',department:'Operations',grade:'2',performance:'ME',potential:'Mid'},
 {id:'c',name:'Cara Lee',department:'Finance',grade:'10',performance:'UA',potential:'Low'},
].map(r=>({...r,performance:r.performance as CalibrationRosterRow['performance'],potential:r.potential as CalibrationRosterRow['potential'],companyId:'unit',company:'Unit A',performanceSource:'manager',potentialSource:'manager',locked:false,potentialPct:70,journey:[{tier:'self',performance:'ME',potential:'Mid'},{tier:'manager',performance:'AE',potential:'High'}],bandTrails:{performance:[{tier:'self' as const,band:'ME',state:'set' as const},{tier:'manager' as const,band:'AE',state:'moved' as const}],potential:[{tier:'self' as const,band:'Mid',state:'set' as const},{tier:'manager' as const,band:'High',state:'moved' as const}]}}));
const selected=vi.fn();
function Harness({rows=people}:{rows?:CalibrationRosterRow[]}){
 const [filters,onFilters]=useState<TalentListFilters>({}),[sort,onSort]=useState<TalentListSort>({column:'box',direction:-1});
 return <NextIntlClientProvider locale="en" messages={en}><TalentList rows={rows} filters={filters} sort={sort} onFilters={onFilters} onSort={onSort} onSelect={selected} category="" lastViewed={null} active unitId="unit"/></NextIntlClientProvider>;
}
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('uses source columns, sorts and filters in a portal, and applies a searched value immediately',()=>{
 render(<Harness/>);expect(screen.getAllByRole('columnheader').map(h=>h.textContent)).toEqual(['Name','Department','Grade','Performance','Potential','Box','AI','Actions']);expect(screen.queryByText('Unit A')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Department: sort and filter'}));let menu=screen.getByRole('dialog',{name:'Department: sort and filter'});expect(menu.closest('[data-talent-list-scroll]')).toBeNull();
 fireEvent.change(within(menu).getByRole('textbox',{name:'Search Department values'}),{target:{value:'Finance'}});expect(screen.queryByRole('button',{name:'Bob Lim'})).toBeNull();expect(screen.getByText('2 of 3 people')).toBeTruthy();
 fireEvent.click(within(menu).getByRole('checkbox',{name:'Select all'}));expect(screen.getByText(en.onehr.talentList.empty)).toBeTruthy();
 fireEvent.click(within(menu).getByRole('button',{name:'Clear filter'}));expect(screen.getByRole('button',{name:'Bob Lim'})).toBeTruthy();fireEvent.click(within(menu).getByRole('button',{name:'Done'}));expect(screen.queryByRole('dialog')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Grade: sort and filter'}));menu=screen.getByRole('dialog',{name:'Grade: sort and filter'});fireEvent.click(within(menu).getByRole('button',{name:'Sort smallest → largest'}));
 const table=screen.getByRole('region',{name:en.onehr.talentList.title});expect(within(table).getAllByRole('rowheader').map(h=>h.textContent)).toEqual(['Bob Lim','Cara Lee','Alice Tan']);
});
it('combines live column filters, shows only values left by other columns and clears them together',()=>{
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Department: sort and filter'}));let menu=screen.getByRole('dialog');fireEvent.click(within(menu).getByRole('checkbox',{name:'Operations'}));fireEvent.click(within(menu).getByRole('button',{name:'Done'}));
 fireEvent.click(screen.getByRole('button',{name:'Grade: sort and filter'}));menu=screen.getByRole('dialog');expect(within(menu).queryByRole('checkbox',{name:'2'})).toBeNull();fireEvent.click(within(menu).getByRole('checkbox',{name:'10'}));fireEvent.click(within(menu).getByRole('button',{name:'Done'}));
 expect(screen.getByText('1 of 3 people')).toBeTruthy();expect(screen.getByRole('button',{name:'Alice Tan'})).toBeTruthy();expect(screen.queryByRole('button',{name:'Cara Lee'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Clear filters'}));expect(screen.getByText('3 of 3 people')).toBeTruthy();
});
it('reads a rating history without selecting or writing the person, and reads the person explicitly through the AI column',()=>{
 render(<Harness/>);const history=screen.getByRole('button',{name:'Performance history for Alice Tan'});fireEvent.mouseEnter(history);const tooltip=screen.getByRole('tooltip');expect(within(tooltip).getByText(en.onehr.calibrationRoster.lineManager)).toBeTruthy();expect(within(tooltip).getByText('AE')).toBeTruthy();expect(within(tooltip).getByText('↑ Higher')).toBeTruthy();expect(selected).not.toHaveBeenCalled();fireEvent.mouseLeave(history);expect(screen.queryByRole('tooltip')).toBeNull();fireEvent.focus(history);expect(screen.getByRole('tooltip')).toBeTruthy();fireEvent.keyDown(window,{key:'Escape'});expect(screen.queryByRole('tooltip')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Read assessment for Alice Tan'}));expect(selected).toHaveBeenCalledExactlyOnceWith('a');
});
it('renders the first 100 rows and expands by 100 on demand',()=>{
 const rows=Array.from({length:205},(_,i)=>({...people[0],id:`person-${i}`,name:`Person ${i}`}));render(<Harness rows={rows}/>);expect(screen.getAllByRole('rowheader',{hidden:true})).toHaveLength(100);fireEvent.click(screen.getByText('Show 100 more',{selector:'button'}));expect(screen.getAllByRole('rowheader',{hidden:true})).toHaveLength(200);fireEvent.click(screen.getByText('Show 5 more',{selector:'button'}));expect(screen.getAllByRole('rowheader',{hidden:true})).toHaveLength(205);
});
it('refreshes an embedded band save in place and retains the human words if a retry is refused',async()=>{
 ports.save.mockResolvedValueOnce({ok:true}).mockResolvedValueOnce({error:'The calibration changed. Reload before saving.'});const legacy=vi.fn().mockResolvedValue(undefined);
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationBandForm preserveView action={legacy}><input type="hidden" name="revision" value="4" readOnly/><input type="hidden" name="reviewId" value="subject" readOnly/><label>Reason<input name="performanceNote" defaultValue="The observed delivery supports this draft call."/></label><button type="submit">Save</button></CalibrationBandForm></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Save'}));expect(await screen.findByRole('status')).toHaveProperty('textContent',en.onehr.talentList.saved);expect(legacy).not.toHaveBeenCalled();expect(ports.save.mock.calls[0][0].get('revision')).toBe('4');expect(ports.save.mock.calls[0][0].get('performanceNote')).toBe('The observed delivery supports this draft call.');await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());
 fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'Retain this explanation when the save is refused.'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','The calibration changed. Reload before saving.');expect((screen.getByRole('textbox',{name:'Reason'}) as HTMLInputElement).value).toBe('Retain this explanation when the save is refused.');expect(ports.refresh).toHaveBeenCalledOnce();
});
it('picks a nine-box move with an explicit band choice, preserves a refused reason and refreshes only after saving',async()=>{
 ports.save.mockResolvedValueOnce({error:'This record changed. Reload before saving.'}).mockResolvedValueOnce({ok:true});const moved=vi.fn();
 render(<NextIntlClientProvider locale="en" messages={en}><TalentBoxMove person={people[0]} sessionId="scope" revision={7} onMoved={moved}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Move Alice Tan'}));const dialog=screen.getByRole('dialog',{name:'Move Alice Tan'});
 expect(within(dialog).getByRole('button',{name:'Current box: Super Star, High potential, High performance'}).hasAttribute('disabled')).toBe(true);expect(within(dialog).getByRole('button',{name:'Save move'}).hasAttribute('disabled')).toBe(true);expect((within(dialog).getByRole('textbox',{name:en.onehr.talentMove.reason}) as HTMLTextAreaElement).required).toBe(false);
 fireEvent.click(within(dialog).getByRole('button',{name:'Move to PIP/Improvement, Mid potential, Low performance'}));expect(within(dialog).getByRole('button',{name:'BE'}).getAttribute('aria-pressed')).toBe('true');fireEvent.click(within(dialog).getByRole('button',{name:'UA'}));fireEvent.change(within(dialog).getByRole('textbox',{name:en.onehr.talentMove.reason}),{target:{value:'Keep the delivery evidence attached to this move.'}});
 fireEvent.click(within(dialog).getByRole('button',{name:'Save move'}));expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent','This record changed. Reload before saving.');expect((within(dialog).getByRole('textbox') as HTMLTextAreaElement).value).toBe('Keep the delivery evidence attached to this move.');expect(ports.refresh).not.toHaveBeenCalled();expect(moved).not.toHaveBeenCalled();
 const data=ports.save.mock.calls[0][0] as FormData;expect(Object.fromEntries(data)).toEqual({sessionId:'scope',revision:'7',reviewId:'a',performance:'UA',potential:'Mid',performanceNote:'Keep the delivery evidence attached to this move.',potentialNote:'Keep the delivery evidence attached to this move.'});
 fireEvent.click(await within(dialog).findByRole('button',{name:'Save move'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());expect(moved).toHaveBeenCalledOnce();expect(ports.refresh).toHaveBeenCalledOnce();
});
it('saves a nine-box move with the optional reason left empty (APR-022)',async()=>{
 ports.save.mockResolvedValueOnce({ok:true});
 render(<NextIntlClientProvider locale="en" messages={en}><TalentBoxMove person={people[0]} sessionId="scope" revision={7}/></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Move Alice Tan'}));const dialog=screen.getByRole('dialog',{name:'Move Alice Tan'});
 fireEvent.click(within(dialog).getByRole('button',{name:'Move to Star, High potential, Mid performance'}));
 const save=within(dialog).getByRole('button',{name:'Save move'});expect(save.hasAttribute('disabled')).toBe(false);fireEvent.click(save);
 await waitFor(()=>expect(ports.save).toHaveBeenCalledOnce());
 expect(Object.fromEntries(ports.save.mock.calls[0][0] as FormData)).toMatchObject({sessionId:'scope',revision:'7',reviewId:'a',potential:'High',performanceNote:'',potentialNote:''});
});
it('cancels a proposed move without saving and refuses a locked row',()=>{
 const ui=render(<NextIntlClientProvider locale="en" messages={en}><TalentBoxMove person={people[0]} sessionId="scope" revision={7}/></NextIntlClientProvider>);fireEvent.click(screen.getByRole('button',{name:'Move Alice Tan'}));fireEvent.click(screen.getByRole('button',{name:'Move to Star, High potential, Mid performance'}));fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('dialog')).toBeNull();expect(ports.save).not.toHaveBeenCalled();
 ui.rerender(<NextIntlClientProvider locale="en" messages={en}><TalentBoxMove person={people[0]} sessionId="scope" revision={7} disabled/></NextIntlClientProvider>);expect(screen.getByRole('button',{name:'Move Alice Tan'}).hasAttribute('disabled')).toBe(true);
});
it('reads the same band trail on a narrow screen without a provider call or a rating write',()=>{
 const original=window.matchMedia;Object.defineProperty(window,'matchMedia',{configurable:true,writable:true,value:vi.fn(()=>({matches:true,addEventListener:vi.fn(),removeEventListener:vi.fn()}))});
 try{render(<NextIntlClientProvider locale="en" messages={en}><TalentBandHistory name="Alice Tan" axis="performance" steps={[{tier:'self',band:'ME',state:'set'},{tier:'manager',band:'AE',state:'moved'},{tier:'hod',band:null,state:'wait'}]} current="AE" source="manager"/></NextIntlClientProvider>);
  fireEvent.click(screen.getByRole('button',{name:'Performance history for Alice Tan'}));const dialog=screen.getByRole('dialog',{name:'Performance history for Alice Tan'});expect(within(dialog).getByText('Not submitted yet')).toBeTruthy();expect(within(dialog).getByText('On the box: AE, from Line manager')).toBeTruthy();fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));expect(screen.queryByRole('dialog')).toBeNull();expect(ports.save).not.toHaveBeenCalled();
 }finally{Object.defineProperty(window,'matchMedia',{configurable:true,writable:true,value:original});}
});
it('dismisses a floating trail when its list is no longer the active view',()=>{
 const make=(active:boolean)=><NextIntlClientProvider locale="en" messages={en}><TalentBandHistory name="Alice Tan" axis="performance" active={active} steps={[{tier:'self',band:'ME',state:'set'}]} current="ME" source="self"/></NextIntlClientProvider>;
 const ui=render(make(true));fireEvent.focus(screen.getByRole('button',{name:'Performance history for Alice Tan'}));expect(screen.getByRole('tooltip')).toBeTruthy();ui.rerender(make(false));expect(screen.queryByRole('tooltip')).toBeNull();ui.rerender(make(true));expect(screen.queryByRole('tooltip')).toBeNull();
});
it('shows one band trail at a time even when another history button still has keyboard focus',()=>{
 render(<Harness/>);fireEvent.focus(screen.getByRole('button',{name:'Performance history for Alice Tan'}));expect(screen.getByRole('tooltip')).toBeTruthy();fireEvent.mouseEnter(screen.getByRole('button',{name:'Potential history for Bob Lim'}));expect(screen.getAllByRole('tooltip')).toHaveLength(1);expect(within(screen.getByRole('tooltip')).getByText('Potential history for Bob Lim')).toBeTruthy();expect(screen.queryByText('Performance history for Alice Tan')).toBeNull();
});
it('names the improvement box in full in the Box column, its filter menu and its sort labels (D-P1-26)',()=>{
 render(<Harness/>);const table=screen.getByRole('region',{name:en.onehr.talentList.title});
 expect(within(table).getAllByText('PIP/Improvement')).toHaveLength(1);expect(within(table).queryByText('PIP')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Box: sort and filter'}));const menu=screen.getByRole('dialog',{name:'Box: sort and filter'});
 expect(within(menu).getByRole('checkbox',{name:'PIP/Improvement'})).toBeTruthy();expect(within(menu).queryByRole('checkbox',{name:'PIP'})).toBeNull();
 expect(within(menu).getByRole('button',{name:'Sort PIP/Improvement → Super Star'})).toBeTruthy();
 fireEvent.change(within(menu).getByRole('textbox',{name:'Search Box values'}),{target:{value:'Improvement'}});
 expect(screen.getByText('1 of 3 people')).toBeTruthy();expect(within(table).getAllByRole('rowheader').map(h=>h.textContent)).toEqual(['Cara Lee']);
});
