import { useState } from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import { TalentList } from '../app/performance/onehr/talent-list';
import type { CalibrationRosterRow } from '../app/performance/onehr/calibration-roster';
import type { TalentListFilters,TalentListSort } from '../packs/performance/onehr/talent-list-model';
const ports=vi.hoisted(()=>({save:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/performance/onehr-actions',()=>({saveCalibrationBandAction:ports.save}));
import { CalibrationBandForm } from '../app/performance/onehr/calibration-band-form';
const people:CalibrationRosterRow[]=[
 {id:'a',name:'Alice Tan',department:'Finance',grade:'12',performance:'AE',potential:'High'},
 {id:'b',name:'Bob Lim',department:'Operations',grade:'2',performance:'ME',potential:'Mid'},
 {id:'c',name:'Cara Lee',department:'Finance',grade:'10',performance:'UA',potential:'Low'},
].map(r=>({...r,performance:r.performance as CalibrationRosterRow['performance'],potential:r.potential as CalibrationRosterRow['potential'],companyId:'unit',company:'Unit A',performanceSource:'manager',potentialSource:'manager',locked:false,potentialPct:70,journey:[{tier:'self',performance:'ME',potential:'Mid'},{tier:'manager',performance:'AE',potential:'High'}]}));
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
 render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Performance history for Alice Tan'}));const dialog=screen.getByRole('dialog',{name:'Performance history for Alice Tan'});expect(within(dialog).getByText(en.onehr.calibrationRoster.lineManager)).toBeTruthy();expect(within(dialog).getByText('AE')).toBeTruthy();expect(selected).not.toHaveBeenCalled();fireEvent.click(within(dialog).getByRole('button',{name:en.onehr.calibrationRoster.close}));
 fireEvent.click(screen.getByRole('button',{name:'Read assessment for Alice Tan'}));expect(selected).toHaveBeenCalledExactlyOnceWith('a');
});
it('renders the first 100 rows and expands by 100 on demand',()=>{
 const rows=Array.from({length:205},(_,i)=>({...people[0],id:`person-${i}`,name:`Person ${i}`}));render(<Harness rows={rows}/>);expect(screen.getAllByRole('rowheader')).toHaveLength(100);fireEvent.click(screen.getByRole('button',{name:'Show 100 more'}));expect(screen.getAllByRole('rowheader')).toHaveLength(200);fireEvent.click(screen.getByRole('button',{name:'Show 5 more'}));expect(screen.getAllByRole('rowheader')).toHaveLength(205);
});
it('refreshes an embedded band save in place and retains the human words if a retry is refused',async()=>{
 ports.save.mockResolvedValueOnce({ok:true}).mockResolvedValueOnce({error:'The calibration changed. Reload before saving.'});const legacy=vi.fn().mockResolvedValue(undefined);
 render(<NextIntlClientProvider locale="en" messages={en}><CalibrationBandForm preserveView action={legacy}><input type="hidden" name="revision" value="4" readOnly/><input type="hidden" name="reviewId" value="subject" readOnly/><label>Reason<input name="performanceNote" defaultValue="The observed delivery supports this draft call."/></label><button type="submit">Save</button></CalibrationBandForm></NextIntlClientProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Save'}));expect(await screen.findByRole('status')).toHaveProperty('textContent',en.onehr.talentList.saved);expect(legacy).not.toHaveBeenCalled();expect(ports.save.mock.calls[0][0].get('revision')).toBe('4');expect(ports.save.mock.calls[0][0].get('performanceNote')).toBe('The observed delivery supports this draft call.');await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());
 fireEvent.change(screen.getByRole('textbox',{name:'Reason'}),{target:{value:'Retain this explanation when the save is refused.'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));expect(await screen.findByRole('alert')).toHaveProperty('textContent','The calibration changed. Reload before saving.');expect((screen.getByRole('textbox',{name:'Reason'}) as HTMLInputElement).value).toBe('Retain this explanation when the save is refused.');expect(ports.refresh).toHaveBeenCalledOnce();
});
