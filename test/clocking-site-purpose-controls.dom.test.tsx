/** Rendered projections only; native source authority is exercised in the separate database suite. */
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import type {ClockingLocationRow} from '../packs/attendance/service';
const {flags}=vi.hoisted(()=>({flags:{view:true,add:true,edit:true,delete:true}}));
const companyId='22222222-2222-4222-8222-222222222222',siteId='33333333-3333-4333-8333-333333333333';
const site:ClockingLocationRow={id:siteId,name:'Fictional shared gate',lat:3.1,lng:101.6,radiusM:100,locationId:null,locationCode:null,locationName:null,locationCompanyName:null,locationArchivedAt:null,address:null,remarks:null,reportLabel:null,state:null,archivedAt:null,assignedCount:0,companies:[{id:companyId,name:'Fictional company'}]};
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]}),isGroupAdmin:()=>true}));
vi.mock('../packs/attendance/service',()=>({listClockingLocationsForMaintenance:async()=>{if(!flags.view)throw new Error('Clocking site action unavailable');return [site];},clockingSiteActionAccess:async(_ctx:unknown,operation:keyof typeof flags)=>flags[operation]}));
vi.mock('../core/read',()=>({listCompanies:async()=>[{id:companyId,name:'Fictional company',companyLabel:null}]}));
vi.mock('../core/location',()=>({listLocations:async()=>[],listUnmappedBranches:async()=>[]}));
vi.mock('../components/attendance-settings-navigation',()=>({AttendanceSettingsNavigation:()=>null}));
vi.mock('../components/ui/confirm-submit',()=>({ConfirmSubmit:({children,disabled}:{children:React.ReactNode;disabled?:boolean})=><button disabled={disabled}>{children}</button>}));
vi.mock('../app/admin/actions',()=>({archiveClockingLocationAction:vi.fn(),restoreClockingLocationAction:vi.fn(),deleteClockingLocationAction:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT:'+url);},notFound:()=>{throw new Error('NOT_FOUND');}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=> (key:string)=>key}));
import ClockingListPage from '../app/admin/work-locations/clocking/page';
import ViewClockingLocationPage from '../app/admin/work-locations/clocking/[id]/page';
import EditClockingLocationPage from '../app/admin/work-locations/clocking/[id]/edit/page';
import NewClockingLocationPage from '../app/admin/work-locations/clocking/new/page';
afterEach(()=>{cleanup();flags.view=true;flags.add=true;flags.edit=true;flags.delete=true;});
it('keeps View and Edit visible when Add is denied, with the separate Delete control disabled',async()=>{
 flags.add=false;flags.delete=false;
 render(await ClockingListPage({searchParams:Promise.resolve({company:companyId})}));
 expect(screen.getByText('Fictional shared gate')).toBeInTheDocument();
 expect(screen.getByRole('link',{name:'view'})).toHaveAttribute('href',`/admin/work-locations/clocking/${siteId}?company=${companyId}`);
 expect(screen.getByRole('link',{name:'edit'})).toBeInTheDocument();
 expect(screen.queryByRole('link',{name:/newClocking/})).not.toBeInTheDocument();
 expect(screen.getByRole('button',{name:'deactivate'})).toBeDisabled();
});
it('keeps actual site facts and Delete independent of an absent Edit projection',async()=>{
 flags.edit=false;
 render(await ViewClockingLocationPage({params:Promise.resolve({id:siteId}),searchParams:Promise.resolve({})}));
 expect(screen.getByText('gpsCoordinates')).toBeInTheDocument();expect(screen.getByText('3.1, 101.6')).toBeInTheDocument();
 expect(screen.queryByRole('link',{name:'edit'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'delete'})).toBeEnabled();
});
it('does not render a form on direct Edit/Add routes when their exact operation is denied',async()=>{
 flags.edit=false;flags.add=false;
 await expect(EditClockingLocationPage({params:Promise.resolve({id:siteId}),searchParams:Promise.resolve({})})).rejects.toThrow('REDIRECT:/admin/work-locations/clocking/'+siteId);
 await expect(NewClockingLocationPage({searchParams:Promise.resolve({})})).rejects.toThrow('REDIRECT:/admin/work-locations/clocking');
});
it('refuses the real maintenance list when its exact View projection is denied',async()=>{
 flags.view=false;await expect(ClockingListPage({searchParams:Promise.resolve({company:companyId})})).rejects.toThrow('Clocking site action unavailable');
});
