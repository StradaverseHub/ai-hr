import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import { createTranslator,NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import type { getAssessmentFinalBands } from '../packs/performance/service';
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({finalBandsAction:vi.fn()}));
import { FinalBandsView } from '../app/(app)/performance/onehr/final-bands-view';
type View=Awaited<ReturnType<typeof getAssessmentFinalBands>>;
const fixture=()=>({session:{id:'scope',cycleId:'cycle',name:'Shared services',revision:4,mode:'blend',bgWeight:50},cycle:{name:'Annual review',status:'open'},sourceDigest:'digest',rows:[
 {reviewId:'one',employmentId:'one-e',name:'Nadia',employeeCode:'E01',department:'Finance',companyId:'company',company:'Acme',businessGroup:'North',ready:true,finalized:false,bg:'AE',group:'ME',draft:null,groupLockedAt:new Date(),suggestion:{band:null,tie:['ME','AE'],why:'halfway'},waiting:null,final:null,agreed:false},
 {reviewId:'two',employmentId:'two-e',name:'Arun',employeeCode:'E02',department:'Finance',companyId:'company',company:'Acme',businessGroup:'North',ready:true,finalized:false,bg:'ME',group:null,draft:'AE',groupLockedAt:null,suggestion:null,waiting:'group',final:null,agreed:false},
 {reviewId:'three',employmentId:'three-e',name:'Evelyn',employeeCode:'E03',department:'Finance',companyId:'company',company:'Acme',businessGroup:'North',ready:false,finalized:false,bg:null,group:null,draft:null,groupLockedAt:null,suggestion:null,waiting:'manager',final:null,agreed:false},
]} as View);
async function show(v=fixture(),error?:string){return render(<NextIntlClientProvider locale="en" messages={en}>{await FinalBandsView({v,error})}</NextIntlClientProvider>);}
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('renders both calls, an explicit tie and an unlocked draft without offering a bulk acceptance',async()=>{
 await show();expect(screen.getByText('ME / AE')).toBeTruthy();expect(screen.getByText(en.onehr.finalBands.why.halfway)).toBeTruthy();expect(screen.getByText('Draft AE, unlocked')).toBeTruthy();
 expect(screen.queryByRole('button',{name:/Accept clear suggestions/})).toBeNull();expect(screen.queryByRole('combobox',{name:'Final band for Evelyn'})).toBeNull();
 expect(screen.getByRole('link',{name:en.onehr.finalBands.download}).getAttribute('href')).toBe('/performance/assessment/calibration/scope/final-bands');
 const form=screen.getByRole('combobox',{name:'Final band for Nadia'}).closest('form')!;
 expect(new FormData(form).get('sourceDigest')).toBe('digest');expect(new FormData(form).get('reviewId')).toBe('one');
 const submit=vi.spyOn(HTMLFormElement.prototype,'requestSubmit').mockImplementation(()=>{});
 fireEvent.click(within(form).getByRole('button',{name:'Decide'}));expect(submit).not.toHaveBeenCalled();expect(await screen.findByRole('alertdialog')).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(submit).not.toHaveBeenCalled();
});
it('separates bulk acceptance, final-band clear and Group reopen controls and retains a failed decision message',async()=>{
 const v=fixture();v.session.mode='after';v.rows[0].suggestion={band:'ME',tie:null,why:'group'};v.rows[0].agreed=true;v.rows[1].group='AE';v.rows[1].groupLockedAt=new Date();v.rows[1].draft=null;v.rows[1].final={sessionId:'final',revision:2,performance:'OU',reason:'Verified exceptional delivery.',by:'HR reviewer',at:new Date().toISOString()};
 await show(v,'These calls changed. Reload before deciding.');expect(screen.getByRole('alert').textContent).toContain('These calls changed.');expect(screen.getByRole('button',{name:'Accept clear suggestions (1)'})).toBeTruthy();expect(screen.getByRole('button',{name:'Reopen Group call'})).toBeTruthy();expect(screen.getByRole('button',{name:'Clear final band'})).toBeTruthy();expect(screen.getByText('Verified exceptional delivery.')).toBeTruthy();
 const clear=screen.getByRole('button',{name:'Clear final band'}).closest('form')!;expect(new FormData(clear).get('reviewId')).toBe('two');expect(new FormData(clear).get('action')).toBe('clear');
});
it('makes a closed cycle and a frozen person read-only and gives the empty scope a useful state',async()=>{
 const v=fixture();v.cycle.status='closed';let ui=await show(v);expect(screen.queryByRole('combobox')).toBeNull();expect(screen.queryByRole('button')).toBeNull();ui.unmount();
 v.cycle.status='open';v.rows=[{...v.rows[0],finalized:true}];ui=await show(v);expect(screen.queryByRole('combobox',{name:'Final band for Nadia'})).toBeNull();ui.unmount();
 v.rows=[];await show(v);expect(screen.getByText(en.onehr.finalBands.empty)).toBeTruthy();expect(screen.queryByRole('region',{name:'Final bands'})).toBeNull();
});
