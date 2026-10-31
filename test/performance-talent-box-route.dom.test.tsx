/**
 * D-P1-26/27 — the standalone Talent Box (/performance/calibration/talent-box): which session it opens and for whom
 * (BU, BG and Group Talent Box parts only; an HOD or a crafted session gets notFound), the area's Calibration strip, the
 * board's look and wording, the BG read-only per-axis lists (DQ-8), and that a move from the board still goes
 * through the one existing writer.
 */
import React from 'react';
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react';
import { NextIntlClientProvider,createTranslator } from 'next-intl';
import en from '../messages/en.json';
import { defaultPolicy } from '../packs/performance/onehr/model';
import framework from '../packs/performance/onehr/framework.json';
import { profitCurveFor } from '../packs/performance/onehr/calibration-curve-model';
const ports=vi.hoisted(()=>({workspace:vi.fn(),calibration:vi.fn(),module:vi.fn(),session:vi.fn(),move:vi.fn()}));
const nav=vi.hoisted(()=>({path:'/performance/calibration/talent-box',search:''}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:'en',messages:en,namespace:namespace as never})}));
vi.mock('next/navigation',async importActual=>({...await importActual<typeof import('next/navigation')>(),useRouter:()=>({refresh:vi.fn()}),usePathname:()=>nav.path,useSearchParams:()=>new URLSearchParams(nav.search),notFound:()=>{throw new Error('NEXT_NOT_FOUND');}}));
vi.mock('../lib/authz',()=>({requireModule:ports.module}));
vi.mock('../lib/scope',()=>({scopedSession:ports.session}));
// The page reads the worklist and the strip's gate facts in one call; the facts are the items' projection, as in tab-service.ts.
vi.mock('../packs/performance/service',()=>({getOnehrCalibration:ports.calibration,getPerformanceAreaFactsAndItems:async()=>{
 const items=await ports.workspace() as PerformanceWorkspaceItem[];
 return {items,facts:{performanceOn:true,ownFeedbackReport:'none',items:items.map(({kind,cycleId,view,module,stage,axis,locked})=>({kind,cycleId,view,module,stage,axis,locked}))}};
}}));
vi.mock('../app/(app)/performance/onehr-actions',()=>({saveCalibrationBandAction:ports.move,onehrCalibrationAction:vi.fn(),agreeDepartmentAction:vi.fn(),assessmentInsightAction:vi.fn(),assessmentCalibrationPersonAction:vi.fn(),assessmentTalentPersonAction:vi.fn().mockResolvedValue({error:'No person frame in this fixture.'}),assessmentTalentInsightAction:vi.fn().mockResolvedValue({pending:true,source:null,data:null}),changeGroupBandAction:vi.fn(),lockGroupPeopleAction:vi.fn(),previewCalibrationFitAction:vi.fn(),applyCalibrationFitAction:vi.fn()}));
import TalentBoxPage from '../app/(app)/performance/calibration/talent-box/page';
import { TalentAxisList } from '../app/(app)/performance/calibration/talent-box/axis-list';
import { AssessmentCalibrationView } from '../app/(app)/performance/onehr/calibration-view';
import { talentCategoryColours } from '../app/(app)/performance/onehr/talent-board';
import type { PerformanceWorkspaceItem } from '../packs/performance/service';

type Part={id:string;view:string;stage:string;kind?:string;module?:string;title?:string};
/** Each part carries the axis leaderWorkspaceParts gives it, which the strip's gates read. */
const axisOf=(stage:string)=>stage==='talent_box'?'both':stage==='potential_calibration'||stage==='department_potential_review'?'potential':'performance';
const item=(p:Part)=>({key:`${p.id}.${p.stage}`,id:p.id,kind:p.kind??'calibration',cycleId:'c1',cycle:'Annual',periodEnd:'2026-12-31',view:p.view,module:p.module??'cal',axis:axisOf(p.stage),state:'open',title:p.title??'BU review',stage:p.stage,locked:false}) as PerformanceWorkspaceItem;
const hod=[item({id:'d',view:'dept',stage:'department_review'}),item({id:'d',view:'dept',stage:'department_potential_review'}),item({id:'r',view:'mine',kind:'review',module:'pm',stage:'results'})];
const bu=[item({id:'session',view:'bu',stage:'calibration'}),item({id:'session',view:'bu',stage:'potential_calibration'}),item({id:'session',view:'bu',stage:'talent_box'})];
const bg=[item({id:'session',view:'bg',stage:'talent_box',title:'BG review'})];
const group=[item({id:'session',view:'group',stage:'group_calibration',title:'Group review'}),item({id:'session',view:'group',stage:'talent_box',title:'Group review'})];

const normal={UA:5,BE:10,ME:70,AE:10,OU:5};
const entry=(reviewId:string)=>({id:`entry-${reviewId}`,reviewId,performance:null,potential:null,performanceLockedAt:null,potentialLockedAt:null,lockedAt:null,performanceNote:'',potentialNote:'',pip:false,promotion:false,specialReward:false});
const person=(reviewId:string,name:string,companyId:string,performance='ME',potential='High')=>({companyId,department:'Sales',canWrite:{pm:true,pot:true},talent:null,name,grade:'12',finalized:false,managerPerformance:performance,managerPotential:potential,currentPerformance:performance,currentPotential:potential,movement:{moved:false,fromCategory:null,from:{performance,potential}},entry:entry(reviewId)});
const unit=(id:string,name:string)=>({id,name,locked:false,profit:profitCurveFor(id,null,[])});
function view(tier:string,{tm=true,units=[unit('x','Unit X')],rows=[person('review','Employee','x')]}:{tm?:boolean;units?:ReturnType<typeof unit>[];rows?:ReturnType<typeof person>[]}={}){
 return {isReviewer:true,session:{id:'session',name:tier==='bg'?'BG review':tier==='group'?'Group review':'BU review',tier,revision:2,reviewerUserIds:['me'],performanceLockedAt:null,potentialLockedAt:null,lockedAt:null},actorUserId:'me',cycle:{name:'Annual'},axes:{pm:true,pot:tm},units,modules:{pm:true,tm},reference:normal,curvePolicy:defaultPolicy(framework),talentBox:{grid:9,cap:null},canSubmit:{pm:true,pot:tm},canLockCohort:true,rows};
}
/** Await the async server parts of the page (the calibration view and the axis list) so the client can render the tree. */
async function resolved(node:React.ReactNode):Promise<React.ReactNode>{
 if(Array.isArray(node))return Promise.all(node.map(resolved));
 if(!React.isValidElement(node))return node;
 const el=node as React.ReactElement<{children?:React.ReactNode}>;
 if((el.type as unknown)===AssessmentCalibrationView||(el.type as unknown)===TalentAxisList)return resolved(await (el.type as unknown as (props:unknown)=>Promise<React.ReactNode>)(el.props));
 if(el.props.children===undefined)return el;
 const children=await resolved(el.props.children);
 return React.cloneElement(el,undefined,...(Array.isArray(children)?children:[children]));
}
async function open(searchParams:Record<string,string>={}){
 nav.search=new URLSearchParams(searchParams).toString();
 const page=await TalentBoxPage({searchParams:Promise.resolve(searchParams)});
 render(<NextIntlClientProvider locale="en" messages={en}>{await resolved(page)}</NextIntlClientProvider>);
}
const board=()=>screen.getByRole('region',{name:en.onehr.talentBoard.title});
/** The area's one Calibration strip (PT-X1's PerformanceTabStrip). */
const strip=()=>screen.getByRole('navigation',{name:en.performanceArea.admin.sections.calibration});
beforeEach(()=>{vi.clearAllMocks();ports.session.mockResolvedValue({s:{tenantId:'tenant'}});ports.move.mockResolvedValue({ok:true});});
afterEach(cleanup);

describe('the standalone Talent Box page',()=>{
 it('answers notFound to an HOD, to a crafted session and to a cycle without both axes, before reading a board',async()=>{
  ports.workspace.mockResolvedValue(hod);
  await expect(TalentBoxPage({searchParams:Promise.resolve({})})).rejects.toThrow('NEXT_NOT_FOUND');
  await expect(TalentBoxPage({searchParams:Promise.resolve({session:'d'})})).rejects.toThrow('NEXT_NOT_FOUND');
  expect(ports.calibration).not.toHaveBeenCalled();
  ports.workspace.mockResolvedValue(bu);
  await expect(TalentBoxPage({searchParams:Promise.resolve({session:'someone-else'})})).rejects.toThrow('NEXT_NOT_FOUND');
  await expect(TalentBoxPage({searchParams:Promise.resolve({session:['session','session']} as unknown as Record<string,string>)})).rejects.toThrow('NEXT_NOT_FOUND');
  expect(ports.calibration).not.toHaveBeenCalled();
  expect(ports.module).toHaveBeenCalledWith('performance');
  ports.calibration.mockResolvedValue(view('bu',{tm:false}));
  await expect(TalentBoxPage({searchParams:Promise.resolve({})})).rejects.toThrow('NEXT_NOT_FOUND');
  expect(ports.calibration).toHaveBeenCalledWith({tenantId:'tenant'},'session','both','roster');
 });

 it('draws the BU board: strip, breadcrumb, pills, filters, category tabs, solid heads with VS chips, row labels and the lock bar',async()=>{
  ports.workspace.mockResolvedValue(bu);ports.calibration.mockResolvedValue(view('bu'));
  await open();
  const tabs=within(strip()).getAllByRole('link');
  expect(tabs.map(tab=>tab.textContent)).toEqual(['Performance','Potential','Talent box']);
  expect(tabs.map(tab=>tab.getAttribute('aria-current'))).toEqual([null,null,'page']);
  // BU keeps the registry's per-axis lists; the board link stays on this session.
  expect(tabs.map(tab=>tab.getAttribute('href'))).toEqual(['/performance/calibration?axis=performance','/performance/calibration?axis=potential','/performance/calibration/talent-box?session=session']);
  const region=board();
  expect(within(region).getByText('Talent Box ▸ Business unit')).toBeTruthy();
  expect(within(region).getByRole('heading',{name:'BU review'})).toBeTruthy();
  for(const pill of ['1 person','1 business unit','1 of 1 placed','Open for review'])expect(within(region).getByText(pill)).toBeTruthy();
  expect(region.querySelector('[data-board-state]')?.getAttribute('data-board-state')).toBe('open');
  expect(within(region).getByLabelText('Department')).toBeTruthy();expect(within(region).getByLabelText('Job grade')).toBeTruthy();
  expect(within(region).getAllByRole('tab').map(tab=>tab.textContent)).toEqual(['9-box','Table','PIP/Improvement 0','Solid Core 0','Star 1','Super Star 0']);
  expect(within(within(region).getByRole('region',{name:en.onehr.talentBoard.referenceTitle})).getByRole('button',{expanded:false}).textContent).toContain(en.onehr.talentBoard.showDetails);
  // Rows read top to bottom as High, Medium, Low.
  expect([...region.querySelectorAll('[data-board-row]')].map(row=>row.textContent)).toEqual(['3 – High','2 – Medium','1 – Low']);
  const cells=[...region.querySelectorAll<HTMLElement>('[data-board-cell]')];expect(cells).toHaveLength(9);
  // Each head is solid in its own category's colour, declared once on the board.
  for(const cell of cells){
   const slug=cell.getAttribute('data-talent-category')!,head=cell.querySelector('[data-board-cell-head]')!;
   expect(Object.values(talentCategoryColours).map(c=>c.slug)).toContain(slug);
   expect(head.className).toContain(`bg-[var(--talent-${slug})]`);expect(head.className).toContain('uppercase');expect(head.className).toContain('text-white');
   expect(cell.className).toContain(`bg-[var(--talent-${slug}-tint)]`);
   expect(cell.querySelector('[data-board-vs]')?.textContent).toMatch(/^vs \d+(\.\d+)?%$/);
   expect(cell.querySelector('[data-board-cell-body]')!.className).toContain('min-[1081px]:grid-cols-2');
   expect(cell.querySelector('[data-board-cell-body]')!.className).toContain('grid-cols-1');
  }
  for(const c of Object.values(talentCategoryColours)){expect(region.style.getPropertyValue(`--talent-${c.slug}`)).toBe(c.head);expect(region.style.getPropertyValue(`--talent-${c.slug}-tint`)).toBe(c.tint);}
  const star=screen.getByRole('group',{name:'Star, High potential, Mid performance: 1'});
  expect(star.getAttribute('data-talent-category')).toBe('star');expect(within(star).getByRole('button',{name:'Employee'})).toBeTruthy();
  expect(screen.getByRole('group',{name:/^PIP\/Improvement, Mid potential/}).getAttribute('data-talent-category')).toBe('pip-improvement');
  expect(screen.getByRole('group',{name:/^Super Star, High potential/}).getAttribute('data-talent-category')).toBe('super-star');
  expect(screen.getByRole('group',{name:/^Solid Core, Mid potential, Mid performance/}).getAttribute('data-talent-category')).toBe('solid-core');
  expect(region.textContent).toContain(`● ${en.onehr.talentBoard.legendSame}`);
  const bar=region.querySelector('footer')!;
  expect(bar.textContent).toContain('1 placed · locking covers both performance and potential for BU review');
  expect(within(bar).getAllByRole('button',{name:'Lock calibration'})).toHaveLength(1);
  expect(screen.getAllByRole('button',{name:'Lock calibration'})).toHaveLength(1);
 });

 it('says PIP/Improvement and Lock calibration in full, in the move dialog too',async()=>{
  expect(en.onehr.lockCalibration).toBe('Lock calibration');expect(en.onehr.lockConfirm).toBe('Lock this calibration?');
  expect(JSON.stringify(en.onehr.talentBoard)+JSON.stringify(en.onehr.talentMove)).not.toMatch(/cohort/i);
  ports.workspace.mockResolvedValue(bu);ports.calibration.mockResolvedValue(view('bu'));
  await open();
  fireEvent.click(screen.getByRole('button',{name:'Move Employee to another box'}));
  const dialog=await screen.findByRole('dialog',{name:'Move Employee'});
  expect(within(dialog).getAllByText('PIP/Improvement')).toHaveLength(2);expect(within(dialog).queryByText('PIP')).toBeNull();
 });

 it('saves a move from the board through the existing Talent Box writer',async()=>{
  ports.workspace.mockResolvedValue(bu);ports.calibration.mockResolvedValue(view('bu'));
  await open();
  fireEvent.click(screen.getByRole('button',{name:'Move Employee to another box'}));
  const dialog=await screen.findByRole('dialog',{name:'Move Employee'});
  fireEvent.click(within(dialog).getByRole('button',{name:/^Move to Super Star, High potential/}));
  fireEvent.click(within(dialog).getByRole('button',{name:en.onehr.talentMove.save}));
  await waitFor(()=>expect(ports.move).toHaveBeenCalledOnce());
  expect(Object.fromEntries((ports.move.mock.calls[0][0] as FormData).entries())).toEqual({sessionId:'session',revision:'2',reviewId:'review',performance:'AE',potential:'High',performanceNote:'',potentialNote:''});
 });

 it('gives the BG CEO the whole-scope lock at All and the unit lock once a unit is picked',async()=>{
  ports.workspace.mockResolvedValue(bg);
  ports.calibration.mockResolvedValue(view('bg',{units:[unit('x','Unit X'),unit('y','Unit Y')],rows:[person('a','Ana Lim','x'),person('b','Ben Ong','y','BE','Low')]}));
  await open();
  const region=board();
  expect(within(region).getByText('Talent Box ▸ Business group')).toBeTruthy();
  expect(within(region).getByRole('group',{name:en.onehr.talentBoard.businessUnit})).toBeTruthy();
  expect(screen.getByRole('button',{name:'All 2'}).getAttribute('aria-pressed')).toBe('true');
  const bar=()=>region.querySelector('footer')!;
  expect(within(bar()).getByRole('button',{name:'Lock calibration'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Unit Y 1'}));
  expect(within(bar()).getByRole('button',{name:en.onehr.lockBusinessUnit})).toBeTruthy();expect(within(bar()).queryByRole('button',{name:'Lock calibration'})).toBeNull();
  expect(within(strip()).getAllByRole('link').map(tab=>tab.getAttribute('href'))).toEqual(['/performance/calibration/talent-box?session=session&axis=performance','/performance/calibration/talent-box?session=session&axis=potential','/performance/calibration/talent-box?session=session']);
 });

 it('opens the BG Performance and Potential tabs as read-only lists of the BG session',async()=>{
  ports.workspace.mockResolvedValue(bg);
  ports.calibration.mockResolvedValue(view('bg',{units:[unit('x','Unit X'),unit('y','Unit Y')],rows:[person('b','Ben Ong','y','BE','Low'),person('a','Ana Lim','x')]}));
  await open({session:'session',axis:'potential'});
  expect(within(strip()).getByRole('link',{name:'Potential'}).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByRole('region',{name:en.onehr.talentBoard.title})).toBeNull();
  const list=screen.getByRole('region',{name:'Potential'});
  expect(within(list).getAllByRole('row').slice(1).map(row=>row.textContent)).toEqual(['Ana LimUnit XSales12High','Ben OngUnit YSales12Low']);
  expect(within(list).queryAllByRole('button')).toEqual([]);expect(document.querySelector('form')).toBeNull();
  cleanup();await open({session:'session',axis:'performance'});
  expect(within(screen.getByRole('region',{name:'Performance'})).getAllByRole('row').slice(1).map(row=>row.textContent)).toEqual(['Ana LimUnit XSales12ME','Ben OngUnit YSales12BE']);
 });

 it('names the Group scope a calibration group and offers no Potential tab',async()=>{
  ports.workspace.mockResolvedValue(group);ports.calibration.mockResolvedValue({...view('group'),reference:null});
  await open();
  expect(within(board()).getByText('Talent Box ▸ Calibration group')).toBeTruthy();
  expect(within(strip()).getAllByRole('link').map(tab=>tab.textContent)).toEqual(['Performance','Talent box']);
 });
});
