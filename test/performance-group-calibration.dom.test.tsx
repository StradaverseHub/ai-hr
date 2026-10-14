import React from 'react';
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within,waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
const ports=vi.hoisted(()=>({change:vi.fn(),lock:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:ports.refresh})}));
vi.mock('../app/performance/onehr-actions',()=>({changeGroupBandAction:ports.change,lockGroupPeopleAction:ports.lock}));
import { GroupCalibration,type GroupCalibrationPerson } from '../app/performance/onehr/group-calibration';
const rows:GroupCalibrationPerson[]=[
 {id:'alice',name:'Alice Tan',grade:'12',companyId:'a',company:'Unit A',department:'Sales',businessGroupId:'g1',businessGroup:'Group One',manager:'ME',bg:'AE',mine:'ME',locked:false,canWrite:true},
 {id:'bob',name:'Bob Lim',grade:'12',companyId:'a',company:'Unit A',department:'Operations',businessGroupId:'g1',businessGroup:'Group One',manager:'ME',bg:'ME',mine:'AE',locked:false,canWrite:true},
 {id:'cara',name:'Cara Lee',grade:'12',companyId:'b',company:'Unit B',department:'Sales',businessGroupId:'g2',businessGroup:'Group Two',manager:'ME',bg:'AE',mine:'AE',locked:true,canWrite:false},
 {id:'dan',name:'Dan Ng',grade:'12',companyId:'b',company:'Unit B',department:'',businessGroupId:'g2',businessGroup:'Group Two',manager:null,bg:null,mine:null,locked:false,canWrite:false},
];
function show(){render(<NextIntlClientProvider locale="en" messages={en}><GroupCalibration sessionId="session" revision={3} rows={rows} mode="replace"/></NextIntlClientProvider>);}
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('uses source Group table, hierarchical filters and only current lockable calls',()=>{
 show();expect(screen.getByRole('columnheader',{name:en.onehr.groupCalibration.yourCall})).toBeTruthy();expect(screen.queryByText(en.onehr.potential)).toBeNull();
 expect(screen.getAllByRole('combobox')).toHaveLength(2);expect(screen.queryByRole('group',{name:en.onehr.company})).toBeNull();
 fireEvent.click(within(screen.getByRole('group',{name:en.onehr.groupCalibration.businessGroup})).getByRole('button',{name:/Group One/}));
 fireEvent.click(within(screen.getByRole('group',{name:en.onehr.company})).getByRole('button',{name:/Unit A/}));
 fireEvent.click(within(screen.getByRole('group',{name:en.onehr.groupCalibration.department})).getByRole('button',{name:/Sales/}));
 expect(screen.queryByText('Bob Lim')).toBeNull();expect(screen.queryByText('Cara Lee')).toBeNull();
 fireEvent.click(screen.getByRole('checkbox',{name:en.onehr.calibrationRoster.selectAll}));
 expect(screen.getByRole('button',{name:'Lock selected (1)'})).toBeTruthy();expect(document.querySelector('input[name=reviewId][value=alice]')).toBeTruthy();
 fireEvent.click(within(screen.getByRole('group',{name:en.onehr.groupCalibration.businessGroup})).getByRole('button',{name:/Group Two/}));
 expect(screen.queryByText('Alice Tan')).toBeNull();expect(screen.getByText('Dan Ng')).toBeTruthy();expect(screen.queryByRole('group',{name:en.onehr.groupCalibration.department})).toBeNull();
 expect(screen.getByRole('button',{name:'Lock selected (1)'})).toBeTruthy();
});
it('saves a reversible row call and refreshes only after the canonical writer succeeds',async()=>{
 ports.change.mockResolvedValueOnce({ok:true}).mockResolvedValueOnce({error:'This record changed. Reload before saving.'});show();
 fireEvent.change(screen.getByRole('combobox',{name:'Your call for Alice Tan'}),{target:{value:'OU'}});
 await waitFor(()=>expect(ports.change).toHaveBeenCalledWith('session',3,'alice','OU'));await waitFor(()=>expect(ports.refresh).toHaveBeenCalledOnce());expect(ports.lock).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole('combobox',{name:'Your call for Bob Lim'}),{target:{value:'BE'}});
 expect(await screen.findByRole('alert')).toHaveProperty('textContent','This record changed. Reload before saving.');expect(ports.refresh).toHaveBeenCalledOnce();
});
it('requires a human confirmation to lock selected people and explains unfinished ratings',()=>{
 show();expect(screen.getByText(en.onehr.calibrationRoster.notFinal)).toBeTruthy();expect(screen.queryByRole('checkbox',{name:'Select Dan Ng to lock'})).toBeNull();expect(screen.queryByRole('checkbox',{name:'Select Cara Lee to lock'})).toBeNull();
 fireEvent.click(screen.getByRole('checkbox',{name:'Select Alice Tan to lock'}));fireEvent.click(screen.getByRole('button',{name:'Lock selected (1)'}));
 expect(screen.getByRole('alertdialog')).toBeTruthy();expect(ports.lock).not.toHaveBeenCalled();
});
