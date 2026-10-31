import React from 'react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { NextIntlClientProvider,createTranslator } from 'next-intl';
import en from '../messages/en.json';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({saveCalibrationBandAction:vi.fn(),agreeDepartmentAction:vi.fn(),onehrCalibrationAction:vi.fn(),assessmentInsightAction:vi.fn(),assessmentCalibrationPersonAction:vi.fn(),changeGroupBandAction:vi.fn(),lockGroupPeopleAction:vi.fn()}));
import { TalentBoard } from '../app/(app)/performance/onehr/talent-board';
import { AssessmentCalibrationView } from '../app/(app)/performance/onehr/calibration-view';
import type { CalibrationRosterRow } from '../app/(app)/performance/onehr/calibration-roster';
import { saveCalibrationBandAction } from '../app/(app)/performance/onehr-actions';

const normal={UA:5,BE:10,ME:70,AE:10,OU:5};
const row=(i:number,department:string):CalibrationRosterRow=>({id:`p${i}`,name:`Person ${i}`,grade:i%2?'12':'14',companyId:'x',company:'Unit X',department,performance:'ME',potential:'Mid',performanceSource:'manager',potentialSource:'manager',locked:false,journey:[],potentialPct:null});
const rows=[...Array.from({length:6},(_,i)=>row(i,'Sales')),...Array.from({length:4},(_,i)=>row(i+6,'Operations'))];
function show(extra:Partial<React.ComponentProps<typeof TalentBoard>>={}){
 render(<NextIntlClientProvider locale="en" messages={en}><TalentBoard rows={rows} sessionId="session" revision={3} grid={9} scope={{name:'Unit X',cycle:'Annual'}} locked={false} units={[{id:'x',name:'Unit X'}]} showUnits={false} reference={normal} cap={null} movable {...extra}/></NextIntlClientProvider>);
}
const strip=()=>screen.getByRole('region',{name:en.onehr.talentBoard.referenceTitle});
const chips=()=>within(strip()).getByRole('button',{expanded:false}).textContent;
beforeEach(()=>vi.mocked(saveCalibrationBandAction).mockReset().mockResolvedValue({ok:true}));
afterEach(cleanup);

it('states how many to move per category from the reference, and re-measures when the filters narrow',()=>{
 show();
 expect(screen.getByText('10 people')).toBeTruthy();expect(screen.getByText('10 of 10 placed')).toBeTruthy();
 // 10 Solid Core people: PIP 12.75% → 1, Solid Core 64% → 6, Star 21% → 2, Super Star 2.25% → 0.
 expect(chips()).toContain('PIP/Improvement +1');expect(chips()).toContain('Solid Core −4');expect(chips()).toContain('Star +2');expect(chips()).not.toContain('Super Star');
 expect(screen.getByRole('group',{name:'Solid Core, Mid potential, Mid performance: 10'}).textContent).toContain('100.0%');
 expect(screen.getByRole('group',{name:'Solid Core, Mid potential, Mid performance: 10'}).textContent).toContain('vs 49.0%');
 fireEvent.change(screen.getByLabelText(en.onehr.talentBoard.department),{target:{value:'Operations'}});
 expect(screen.getByText('Measured against the 4 people in this selection.')).toBeTruthy();expect(screen.getByText('4 of 4 placed')).toBeTruthy();
 // 4 people: PIP 0.51 → 1, Solid Core 2.56 → 3, Star 0.84 → 1.
 expect(chips()).toContain('PIP/Improvement +1');expect(chips()).toContain('Solid Core −1');expect(chips()).toContain('Star +1');
 fireEvent.click(within(strip()).getByRole('button',{expanded:false}));
 const table=within(strip()).getByRole('table');expect(within(table).getByRole('row',{name:/Solid Core 4 100\.0% 64\.0% −1/})).toBeTruthy();
 fireEvent.change(screen.getByLabelText(en.onehr.talentBoard.grade),{target:{value:'12'}});expect(screen.getByText('2 of 2 placed')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:en.onehr.talentBoard.clearFilters}));expect(screen.getByText('10 of 10 placed')).toBeTruthy();
});

it('shows no reference shares without a single reference, and a move counter when the ceiling is on',()=>{
 show({reference:null,cap:{pct:20,units:{x:{headcount:10,used:1,cap:2,left:1}}}});
 expect(chips()).toContain('Moves 1 of 2');expect(chips()).not.toContain('+');
 fireEvent.click(within(strip()).getByRole('button',{expanded:false}));expect(within(strip()).getByText(en.onehr.talentBoard.noReference)).toBeTruthy();
 expect(screen.getByRole('group',{name:'Solid Core, Mid potential, Mid performance: 10'}).textContent).not.toContain('vs');
});

async function save(reason:string){
 const dialog=await screen.findByRole('dialog',{name:'Move Person 0'});
 const button=within(dialog).getByRole('button',{name:en.onehr.talentMove.save}) as HTMLButtonElement;
 const box=within(dialog).getByLabelText(en.onehr.talentMove.reason) as HTMLTextAreaElement;
 expect(box.required).toBe(false);expect(button.disabled).toBe(false);// the reason is optional (APR-022): a picked box saves as it is
 if(reason)fireEvent.change(box,{target:{value:reason}});
 fireEvent.click(button);
 await waitFor(()=>expect(saveCalibrationBandAction).toHaveBeenCalled());
 const form=vi.mocked(saveCalibrationBandAction).mock.calls.at(-1)![0] as FormData;return Object.fromEntries(form.entries());
}
it('submits the same payload whether the box is reached by dragging or from the Move to menu',async()=>{
 show();
 const chip=document.querySelector('[data-board-person="p0"]')!,target=screen.getByRole('group',{name:/^Super Star, High potential/});
 const dataTransfer={setData:vi.fn(),getData:()=> 'p0',effectAllowed:'',dropEffect:''};
 fireEvent.dragStart(chip,{dataTransfer});fireEvent.dragOver(target,{dataTransfer});fireEvent.drop(target,{dataTransfer});
 expect(within(await screen.findByRole('dialog',{name:'Move Person 0'})).getByRole('button',{name:/^Move to Super Star, High potential/}).getAttribute('aria-pressed')).toBe('true');
 const dragged=await save('Agreed in the calibration room.');
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 fireEvent.click(screen.getByRole('button',{name:'Move Person 0 to another box'}));
 const dialog=await screen.findByRole('dialog',{name:'Move Person 0'});
 fireEvent.click(within(dialog).getByRole('button',{name:/^Move to Super Star, High potential/}));
 const keyed=await save('Agreed in the calibration room.');
 expect(dragged).toEqual({sessionId:'session',revision:'3',reviewId:'p0',performance:'AE',potential:'High',performanceNote:'Agreed in the calibration room.',potentialNote:'Agreed in the calibration room.'});
 expect(keyed).toEqual(dragged);
});
it('saves a box move with no reason, sending empty notes (APR-022)',async()=>{
 show();
 fireEvent.click(screen.getByRole('button',{name:'Move Person 0 to another box'}));
 fireEvent.click(within(await screen.findByRole('dialog',{name:'Move Person 0'})).getByRole('button',{name:/^Move to Super Star, High potential/}));
 expect(await save('')).toEqual({sessionId:'session',revision:'3',reviewId:'p0',performance:'AE',potential:'High',performanceNote:'',potentialNote:''});
});

it('offers no drag or move on a locked board, for a read-only viewer, or onto the person’s own box',()=>{
 show({locked:true});
 expect(document.querySelector('[data-board-person="p0"]')!.getAttribute('draggable')).toBe('false');
 expect(screen.queryByRole('button',{name:'Move Person 0 to another box'})).toBeNull();
 expect(screen.getByText('Calibration locked for Unit X: performance and potential are final.')).toBeTruthy();
 cleanup();show({movable:false});expect(screen.queryByRole('button',{name:/to another box/})).toBeNull();
 cleanup();show({footer:<button type="button">Lock calibration</button>});
 const own=screen.getByRole('group',{name:'Solid Core, Mid potential, Mid performance: 10'}),dataTransfer={setData:vi.fn(),getData:()=> 'p0',effectAllowed:'',dropEffect:''};
 fireEvent.dragStart(document.querySelector('[data-board-person="p0"]')!,{dataTransfer});fireEvent.drop(own,{dataTransfer});
 expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('button',{name:'Lock calibration'})).toBeTruthy();
});

const entry={id:'entry',reviewId:'review',performance:null,potential:null,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:'',pip:false,promotion:false,specialReward:false};
// isReviewer is decided in SQL (app.onehr_calibration_reviewer: named reviewer or live seat holder, WP-B2).
const view=(tm:boolean,tier='bu')=>({isReviewer:true,session:{id:'session',name:'BU review',tier,revision:2,reviewerUserIds:['me'],performanceLockedAt:null,potentialLockedAt:null,lockedAt:null},actorUserId:'me',cycle:{name:'Annual'},axes:{pm:true,pot:tm},units:[{id:'x',name:'Unit X',locked:false,profit:{reference:normal}}],modules:{pm:true,tm},reference:normal,talentBox:{grid:9,cap:null},canSubmit:{pm:true,pot:tm},canLockCohort:true,rows:[{companyId:'x',canWrite:{pm:true,pot:tm},talent:null,name:'Employee',grade:'12',finalized:false,managerPerformance:'ME',managerPotential:'High',currentPerformance:'ME',currentPotential:'High',movement:{moved:false,fromCategory:null,from:{performance:'ME',potential:'High'}},entry}]});
it('renders the board on the session page with both modules on and no board for a PM-only cycle',async()=>{
 const page=async(tm:boolean,tier='bu')=>render(<NextIntlClientProvider locale="en" messages={en}>{await AssessmentCalibrationView({v:view(tm,tier) as unknown as Parameters<typeof AssessmentCalibrationView>[0]['v']})}</NextIntlClientProvider>);
 await page(true);
 const board=screen.getByRole('region',{name:en.onehr.talentBoard.title});
 expect(within(board).getByRole('button',{name:'Move Employee to another box'})).toBeTruthy();
 expect(within(board).getByRole('button',{name:en.onehr.lockCalibration})).toBeTruthy();// the lock sits in the board's footer
 expect(screen.getAllByRole('button',{name:en.onehr.lockCalibration})).toHaveLength(1);
 expect(en.onehr.lockCalibration).toBe('Lock calibration');// the source's words, not "Lock calibration cohort"
 expect(within(board).getByText('Talent Box ▸ Business unit')).toBeTruthy();
 cleanup();await page(false);
 expect(screen.queryByRole('region',{name:en.onehr.talentBoard.title})).toBeNull();expect(screen.queryByText(en.onehr.talentGrid)).toBeNull();
 cleanup();await page(true,'hod');// a department review reads the board but cannot move on it
 expect(screen.getByRole('region',{name:en.onehr.talentBoard.title})).toBeTruthy();expect(screen.queryByRole('button',{name:/to another box/})).toBeNull();
 expect(screen.getByText(en.onehr.talentBoard.title)).toBeTruthy();expect(screen.queryByText(/Talent Box ▸/)).toBeNull();// no breadcrumb tier below BU
});

it('paints each cell in its category colour, two name chips a row on wide screens, and marks moved and adjusted people',()=>{
 const people=[{...row(0,'Sales'),id:'up',name:'Up Person',from:{performance:'ME' as const,potential:'Mid' as const},performance:'AE' as const,potential:'High' as const},{...row(1,'Sales'),id:'same',name:'Same Box',moved:true,from:{performance:'ME' as const,potential:'Mid' as const}},row(2,'Sales')];
 render(<NextIntlClientProvider locale="en" messages={en}><TalentBoard rows={people} sessionId="session" revision={3} grid={9} scope={{name:'Unit X',cycle:'Annual'}} tier="bg" locked={false} units={[{id:'x',name:'Unit X'}]} showUnits={false} reference={normal} cap={null} movable/></NextIntlClientProvider>);
 expect(screen.getByText('Talent Box ▸ Business group')).toBeTruthy();
 const solid=screen.getByRole('group',{name:'Solid Core, Mid potential, Mid performance: 2'}),star=screen.getByRole('group',{name:'Super Star, High potential, High performance: 1'});
 expect(solid.getAttribute('data-talent-category')).toBe('solid-core');expect(solid.querySelector('[data-board-cell-head]')!.className).toContain('bg-[var(--talent-solid-core)]');
 expect(star.getAttribute('data-talent-category')).toBe('super-star');expect(star.querySelector('[data-board-cell-head]')!.className).toContain('bg-[var(--talent-super-star)]');
 expect(solid.querySelector('[data-board-cell-body]')!.className).toContain('min-[1081px]:grid-cols-2');
 // Rows: High, Medium, Low, as numbered levels.
 expect([...document.querySelectorAll('[data-board-row]')].map(r=>r.textContent)).toEqual(['3 – High','2 – Medium','1 – Low']);
 const up=document.querySelector('[data-board-person="up"]')!,same=document.querySelector('[data-board-person="same"]')!,still=document.querySelector('[data-board-person="p2"]')!;
 expect(up.className).toContain('shadow-[inset_3px_0_0_var(--primary)]');expect(same.className).toContain('shadow-[inset_3px_0_0_var(--primary)]');expect(still.className).not.toContain('shadow-[inset');
 expect(within(same as HTMLElement).getByText(en.onehr.talentBoard.adjustedSame)).toBeTruthy();expect(up.querySelector('[data-board-adjusted]')).toBeNull();
 expect(within(screen.getByRole('button',{name:'Same Box'})).queryByText('●')).toBeNull();// the marker is not part of the name
 expect(document.body.textContent).toContain(en.onehr.talentBoard.legendSame);
});
