import React from 'react';
import {expect,it,vi} from 'vitest';
import {render,screen,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
vi.mock('../app/roster/actions',()=>({assignCellAction:vi.fn(),bulkAssignAction:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn(),push:vi.fn(),refresh:vi.fn()}),useSearchParams:()=>new URLSearchParams('page=1&size=25')}));
import {RosterGrid} from '../components/roster-grid';
it('renders usable second-page employees and stored/rest/usual cells without slicing the server page again',()=>{
 const employees=Array.from({length:25},(_,i)=>({employmentId:'e'+(25+i),name:'Roster row '+(25+i),code:'R'+(25+i),occupation:'Executive'}));
 render(<NextIntlClientProvider locale="en" messages={en}><RosterGrid serverPaged dates={['2027-01-04','2027-01-05','2027-01-06'].map(iso=>({iso,dow:'Mon',day:iso.slice(8)}))} employees={employees} shifts={[{id:'pg',code:'PG',name:'Page shift',startTime:'09:00',endTime:'18:00'}]} initial={{'e25|2027-01-04':{kind:'shift',shiftId:'pg'},'e25|2027-01-05':{kind:'rest'}}} usual={{e25:{shiftId:'pg',pattern:[1,2,3,4,5]}}} isAdmin={false} today="2026-11-07" editQuery="page=1"/></NextIntlClientProvider>);
 expect(screen.getByText('Roster row 25')).toBeVisible();expect(screen.getByText('Roster row 49')).toBeVisible();
 const row=screen.getByText('Roster row 25').closest('tr')!;expect(within(row).getAllByText('PG')).toHaveLength(2);expect(within(row).getByText('RD')).toBeVisible();expect(screen.queryByText('0 of 25')).toBeNull();
});
