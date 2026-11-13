/**
 * aa045103 round 2 (Irwin Law refuted the first staging build): on People > Personnel Management the
 * "Search employee ID or name…" results list was still covered by the menu bar / other page parts.
 *
 * Cause: the list was `absolute z-50` INSIDE the page header, and that header is `position: sticky; z-index:
 * 20` from 640px up (app/globals.css), so its z-50 only counted inside a z-20 layer: anything above 20 in the
 * page (the Monolith top bar at z-30, the Atelier rail flyout at z-50) drew over it, and <main>'s overflow box
 * (overflow-y auto, so overflow-x auto too) clipped it at the sidebar edge and the bottom of a short window.
 * The Columns menu beside it had the same cause. The fix portals both to <body> through
 * components/ui/anchored-panel.tsx (fixed, z-50, re-placed on scroll/resize, flips/caps to the room left).
 *
 * "In front of everything" is a question only a real engine can answer, so this file asks it the way a pointer
 * does: document.elementFromPoint at the list's centre and at every visible option's centre must land INSIDE
 * the list, in Classic, Atelier and Monolith, after scrolling the page, in a short window and with the box at
 * the right edge; then a real (Playwright) click on an option must apply that person's Employee ID. The column
 * header filter and the Columns menu get the same probe.
 *
 * Fixture: the shell's own body/shell/content/header/main classes (test/fixtures/combined-release-shell-
 * geometry.json, so the Monolith top bar keeps its `relative z-30`), a 240px rail, the real PageHeader with
 * the real search box, Filter-sized button and ColumnPicker, and a card with a 40-row table whose filter row
 * carries the real ColumnChoiceFilter. All names are fictional; fetch is mocked; nothing is posted anywhere.
 */
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {page,userEvent} from 'vitest/browser';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import geometry from './fixtures/combined-release-shell-geometry.json';
import '../app/globals.css';
import '../app/onboarding-workspace.css';
import '../app/atelier.css';

const ports=vi.hoisted(()=>({replace:vi.fn(),refresh:vi.fn()}));
vi.mock('next/navigation',()=>({usePathname:()=>'/admin/personnel',useSearchParams:()=>new URLSearchParams(),useRouter:()=>({refresh:ports.refresh,push:vi.fn(),replace:ports.replace})}));
const {PageHeader}=await import('../components/ui');
const {PersonnelAutoFilters}=await import('../app/admin/personnel/auto-filter');
const {PersonnelListSearch}=await import('../app/admin/personnel/list-search');
const {ColumnChoiceFilter}=await import('../app/admin/personnel/column-choice-filter');
const {ColumnPicker}=await import('../app/admin/personnel/column-picker');

type Theme='classic'|'atelier'|'monolith';
const THEMES:Theme[]=['classic','atelier','monolith'];
const departments=['Finance','Human Resources','Information Technology','Operations','Sales'];
// Eight fictional suggestions: the reader's full cap, so the list is as tall as it ever gets.
const suggestions=Array.from({length:8},(_,i)=>({employmentId:`fixture-${i+1}`,name:`Fictional Irwin Person ${i+1}`,employeeCode:`EMP-${String(i+1).padStart(4,'0')}`,company:'Fictional Alpha Sdn Bhd',department:departments[i%departments.length]}));
const fetchMock=vi.fn(async(url:string)=>String(url).startsWith('/api/personnel/search')
 ?Response.json({rows:suggestions})
 :Response.json({href:'/admin/personnel?search='+'a'.repeat(43)+'&size=50'}));

const initialBodyClass=document.body.className,initialMargin=document.body.style.margin;
beforeAll(()=>{vi.stubGlobal('fetch',fetchMock);});
afterAll(()=>{vi.unstubAllGlobals();});
afterEach(async()=>{
 cleanup();vi.clearAllMocks();
 document.body.className=initialBodyClass;document.body.style.margin=initialMargin;
 document.documentElement.removeAttribute('data-ui-theme');
 await page.viewport(1280,844);
});

const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
async function viewport(width:number,height:number){await page.viewport(width,height);await new Promise(r=>setTimeout(r,120));await frame();}
const columnLabels={title:'Columns',hint:'Tick to show. Drag to reorder.',apply:'Apply',reset:'Reset to default',moveUp:'Move up',moveDown:'Move down',unavailableNote:'Not held in Personnel yet: Division.'};
const pickerColumns=[{key:'code',label:'Emp ID'},{key:'name',label:'Full Name',mandatory:true},{key:'company',label:'Company'},{key:'department',label:'Department'},{key:'position',label:'Position'},{key:'status',label:'Status'}];

/** The shell around a Personnel-shaped page. `searchLast` puts the box at the right end of the actions row. */
async function mount(theme:Theme,{width=1280,height=844,searchLast=false,flyout=false}={}){
 await viewport(width,height);
 document.documentElement.setAttribute('data-ui-theme',theme);
 document.body.className=geometry.body;document.body.style.margin='0';
 const search=<PersonnelListSearch key="search" pageSize="50" parameters={[]}/>;
 const others=[
  <button key="filter" type="button" className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-medium">Filter</button>,
  <ColumnPicker key="columns" columns={pickerColumns} selected={['code','name','department']} labels={columnLabels} saveAction={async()=>{}} resetAction={async()=>{}}/>,
 ];
 const view=render(<NextIntlClientProvider locale="en" messages={en}>
  <div data-app-shell className={geometry.shell}>
   {/* A fixed-width rail. With `flyout` its sub-menu is open: components/sidebar.tsx raises the rail's wrapper to
       z-50 and floats the panel OVER the page beside it (Atelier: app/atelier.css .atelier-flyout-open). */}
   <div className={`relative h-full shrink-0 max-sm:hidden ${flyout?'z-50':''}`}>
    <aside data-fixture-sidebar className="h-full w-60 rounded-[1.25rem] border border-border bg-card p-4 text-sm">
     {['Home','People','Payroll','Leave','Attendance'].map(item=><p key={item} className="py-2">{item}</p>)}
    </aside>
    {flyout&&<div data-fixture-flyout className="absolute bottom-2 left-[calc(100%+.5rem)] top-2 w-[15.5rem] rounded-[1.25rem] border border-border bg-popover p-4 text-sm shadow-lg">
     {['Personnel Management','Import employees','Duplicate records','Organisation'].map(item=><p key={item} className="py-2">{item}</p>)}
    </div>}
   </div>
   <div data-app-content className={geometry.content}>
    <header data-app-header className={geometry.header}><span className="text-sm">Fictional top bar</span><span/><span className="justify-self-end text-sm">Fictional Reviewer</span></header>
    <main className={geometry.main} aria-label="Fictional Personnel page">
     <div className="mx-auto max-w-[100rem] space-y-6">
      <PersonnelAutoFilters>
       <PageHeader title="Personnel Management" actions={<div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">{searchLast?[...others,search]:[search,...others]}</div>}/>
       <div data-fixture-card className="rounded-xl border border-border bg-card">
        <div className="overflow-x-auto"><table className="w-full text-sm">
         <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>{['Emp ID','Full Name','Department','Position'].map(label=><th key={label} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">{label}</th>)}</tr>
          <tr>
           <td className="px-4 pb-3"><input aria-label="Filter Emp ID" placeholder="Filter" className="min-h-9 w-full min-w-32 rounded-md border border-input bg-background px-2"/></td>
           <td className="px-4 pb-3"><input aria-label="Filter Full Name" placeholder="Filter" className="min-h-9 w-full min-w-32 rounded-md border border-input bg-background px-2"/></td>
           <td className="px-4 pb-3"><ColumnChoiceFilter name="Department" param="dept" options={departments.map(label=>({value:label.toLowerCase(),label}))} selected={[]} parameters={[]} pageSize="50"/></td>
           <td className="px-4 pb-3"><input aria-label="Filter Position" placeholder="Filter" className="min-h-9 w-full min-w-32 rounded-md border border-input bg-background px-2"/></td>
          </tr>
         </thead>
         <tbody className="divide-y divide-border">{Array.from({length:40},(_,i)=><tr key={i}>
          <td className="px-4 py-3">EMP-{String(100+i).padStart(4,'0')}</td><td className="px-4 py-3">Fictional Table Person {i+1}</td>
          <td className="px-4 py-3">{departments[i%departments.length]}</td><td className="px-4 py-3">Fictional Position</td>
         </tr>)}</tbody>
        </table></div>
       </div>
      </PersonnelAutoFilters>
     </div>
    </main>
   </div>
  </div>
 </NextIntlClientProvider>);
 view.container.style.height='100%';
 await frame();
 return view;
}

const combobox=()=>screen.getByRole('combobox',{name:en.people.switcher.ariaLabel});
const mainEl=()=>screen.getByRole('main',{name:'Fictional Personnel page'});
const sidebarRight=()=>document.querySelector('[data-fixture-sidebar]')!.getBoundingClientRect().right;
const intersects=(a:DOMRect,b:DOMRect)=>a.left<b.right-.5&&a.right>b.left+.5&&a.top<b.bottom-.5&&a.bottom>b.top+.5;

const listbox=()=>screen.queryByRole('listbox',{name:en.people.switcher.resultsLabel});
/**
 * Full gates 43221284271 and 43259497347 (Firefox) stopped here with the list stuck on "Loading…". The suggestions had
 * in fact arrived and been set; the list the test was holding had closed. The browser jobs run several test files at
 * once, each in its own page of ONE Firefox, and when another file's page takes the browser's focus the box gets a real
 * blur (relatedTarget null). The list closes on that blur by design, exactly as when a person switches window, and the
 * test kept polling the detached node, whose last text was "Loading…". Reproduced locally by running this file beside
 * five other browser files in Firefox (3 of 3 failed; with this, 10 of 10 pass).
 *
 * So the wait re-reads the live list on every poll, and only when the WINDOW has lost focus (document.hasFocus() false)
 * does it do what that person does on coming back: focus the box again, which reopens the list (onFocus). A list that
 * closes while the window still has focus is still a failure here.
 */
function reopenIfWindowBlurred(){
 if(!listbox()&&!document.hasFocus()&&(combobox() as HTMLInputElement).value)fireEvent.focusIn(combobox());
}
async function openList({focusOnly=false}={}){
 // focusOnly: the box itself may be under an open side menu, where a pointer cannot reach it (Tab can).
 if(focusOnly)combobox().focus();else await userEvent.click(combobox());
 await userEvent.keyboard('irwi');
 await waitFor(()=>{reopenIfWindowBlurred();expect(listbox(),'the suggestion list closed').not.toBeNull();},{timeout:5000});
 // The suggestions arrive after the box's 200ms typing pause and the (mocked) read. Testing Library's default
 // 1s wait is too tight on a loaded CI runner. What must arrive is unchanged (all 8 + 1).
 await waitFor(()=>{
  reopenIfWindowBlurred();
  const list=listbox();
  expect(list,'the suggestion list closed').not.toBeNull();
  expect(within(list!).getAllByRole('option'),`still waiting: "${list!.querySelector('[role="status"]')?.textContent??''}"`).toHaveLength(suggestions.length+1);
 },{timeout:5000});
 await frame();
 reopenIfWindowBlurred();
 if(!listbox())await frame();
 return listbox()!;
}

/** The list is what a pointer hits at its centre and at the centre of every option currently in view. */
function expectTopmost(panel:HTMLElement,what:string,items:HTMLElement[]=[]){
 const r=panel.getBoundingClientRect();
 const probe=(x:number,y:number)=>{const hit=document.elementFromPoint(x,y);return {hit,ok:!!hit&&panel.contains(hit)};};
 const describeHit=(hit:Element|null)=>hit?`${hit.tagName.toLowerCase()}${hit.id?'#'+hit.id:''}.${String(hit.className).slice(0,80)}`:'nothing';
 const centre=probe(r.left+r.width/2,r.top+r.height/2);
 expect(centre.ok,`${what}: the centre of the panel is covered by ${describeHit(centre.hit)}`).toBe(true);
 let probed=0;
 for(const item of items){
  const o=item.getBoundingClientRect(),y=o.top+o.height/2;
  if(y<r.top+1||y>r.bottom-1)continue; // scrolled out of the panel's own view
  const {hit,ok}=probe(o.left+o.width/2,y);probed++;
  expect(ok,`${what}: "${item.textContent}" is covered by ${describeHit(hit)}`).toBe(true);
 }
 if(items.length)expect(probed,`${what}: no option was in view`).toBeGreaterThan(0);
}
function expectOnScreen(panel:HTMLElement,what:string){
 const r=panel.getBoundingClientRect();
 expect(r.height,`${what} has no height`).toBeGreaterThan(0);
 expect(r.top,`${what} starts above the window`).toBeGreaterThanOrEqual(0);
 expect(r.bottom,`${what} runs past the bottom of the window`).toBeLessThanOrEqual(window.innerHeight);
 expect(r.left,`${what} starts left of the window`).toBeGreaterThanOrEqual(0);
 expect(r.right,`${what} runs past the right of the window`).toBeLessThanOrEqual(window.innerWidth);
}
function expectUnderBox(list:HTMLElement){
 const box=combobox().parentElement!.getBoundingClientRect(),r=list.getBoundingClientRect();
 expect(list.parentElement,'the list is portaled to <body>').toBe(document.body);
 expect(getComputedStyle(list).position).toBe('fixed');
 expect(r.left,'left-anchored under the box').toBeCloseTo(box.left,0);
 expect(r.width,'at least as wide as the box').toBeGreaterThanOrEqual(box.width-.5);
 expect(r.top,'directly under the box').toBeGreaterThanOrEqual(box.bottom);
 expect(r.top-box.bottom,'directly under the box').toBeLessThanOrEqual(8);
 expect(r.left,'never under the sidebar').toBeGreaterThanOrEqual(sidebarRight());
}
const options=(list:HTMLElement)=>within(list).getAllByRole('option');

describe.each(THEMES)('Personnel search suggestions are the topmost layer (%s)',theme=>{
 it('in front of the header, table and filters; follows a 600px scroll; a real click picks the person',async()=>{
  await mount(theme);
  const list=await openList();
  expectUnderBox(list);expectOnScreen(list,'the list');
  expectTopmost(list,`${theme} open`,options(list));
  expect(combobox()).toHaveAttribute('aria-controls',list.id);
  expect(combobox()).toHaveAttribute('aria-expanded','true');

  // The page scrolls under the pinned header; the list stays with the box and stays on top.
  mainEl().scrollTop+=600;
  await frame();
  expect(mainEl().scrollTop).toBeGreaterThan(0);
  expect(screen.getByRole('listbox')).toBe(list);
  expectUnderBox(list);expectOnScreen(list,'the list after scrolling');
  expectTopmost(list,`${theme} scrolled`,options(list));

  // Keyboard contract unchanged.
  await userEvent.keyboard('{ArrowDown}');
  expect(combobox()).toHaveAttribute('aria-activedescendant',options(list)[0].id);

  // A real pointer click at the option's centre (Playwright refuses when another element would take it).
  const target=options(list)[2];
  await userEvent.click(target);
  expect(combobox()).toHaveValue('EMP-0003');
  expect(screen.queryByRole('listbox')).toBeNull();
  await waitFor(()=>expect(fetchMock.mock.calls.some(([url])=>url==='/admin/personnel/search')).toBe(true));
 });

 it.each([560,420])('in a short 1280×%ipx window it stays inside the screen and its last option can be reached',async height=>{
  await mount(theme,{height});
  const list=await openList();
  expectUnderBox(list);expectOnScreen(list,`the list in a ${height}px window`);
  expectTopmost(list,`${theme} short ${height}`,options(list));
  list.scrollTop=list.scrollHeight;await frame();
  const last=options(list).at(-1)!;
  const lr=last.getBoundingClientRect(),r=list.getBoundingClientRect();
  expect(lr.bottom,'the last option is in the list\'s view').toBeLessThanOrEqual(r.bottom+.5);
  expectTopmost(list,`${theme} short ${height}, scrolled to the end`,[last]);
  // Still the combobox's list: scrolling inside it did not close it.
  expect(combobox()).toHaveAttribute('aria-expanded','true');
  await userEvent.click(last);
  expect(screen.queryByRole('listbox')).toBeNull();
 });

 it('in front of a side menu that has opened out over the page',async()=>{
  await mount(theme,{width:768,flyout:true});
  const list=await openList({focusOnly:true});
  const flyout=document.querySelector<HTMLElement>('[data-fixture-flyout]')!;
  const diag=JSON.stringify({list:list.getBoundingClientRect().toJSON(),flyout:flyout.getBoundingClientRect().toJSON()});
  expect(intersects(list.getBoundingClientRect(),flyout.getBoundingClientRect()),`precondition: the menu overlaps the list ${diag}`).toBe(true);
  expectOnScreen(list,'the list beside an open side menu');
  expectTopmost(list,`${theme} over the side menu`,options(list));
 });

 it('with the box at the right end of the actions row it stays on screen and right of the sidebar',async()=>{
  for(const width of [1280,1024]){
   await mount(theme,{width,searchLast:true});
   const list=await openList();
   expectUnderBox(list);expectOnScreen(list,`the list at ${width}px`);
   const diag=JSON.stringify({width,inner:window.innerWidth,list:list.getBoundingClientRect().toJSON(),box:combobox().parentElement!.getBoundingClientRect().toJSON(),main:mainEl().getBoundingClientRect().toJSON(),mainClient:mainEl().clientWidth});
   // Never past the 8px gutter, except where the box itself already reaches further (this harness drops the
   // body padding, so in Classic the box ends AT the window edge): then the list ends exactly with the box.
   const boxRight=combobox().parentElement!.getBoundingClientRect().right;
   expect(list.getBoundingClientRect().right,diag).toBeLessThanOrEqual(Math.max(window.innerWidth-8,boxRight)+.5);
   expectTopmost(list,`${theme} right edge ${width}px`,options(list));
   cleanup();
  }
 });

 it('the Columns menu and the Department column filter are topmost too',async()=>{
  await mount(theme);
  await userEvent.click(screen.getByRole('button',{name:'Columns'}));
  const menu=await screen.findByRole('dialog',{name:'Columns'});
  await frame();
  expect(menu.parentElement).toBe(document.body);
  expectOnScreen(menu,'the Columns menu');
  expectTopmost(menu,`${theme} Columns menu`,[...menu.querySelectorAll<HTMLElement>('li[data-column]'),within(menu).getByRole('button',{name:'Apply'})]);
  mainEl().scrollTop+=600;await frame();
  expectTopmost(menu,`${theme} Columns menu scrolled`,[...menu.querySelectorAll<HTMLElement>('li[data-column]')]);
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog',{name:'Columns'})).toBeNull();
  mainEl().scrollTop=0;await frame();

  const label=en.people.list.controls.filterColumn.replace('{name}','Department');
  await userEvent.click(screen.getByRole('button',{name:label}));
  const panel=await screen.findByRole('dialog',{name:label});
  await frame();
  expectOnScreen(panel,'the Department filter');
  expectTopmost(panel,`${theme} Department filter`,[...panel.querySelectorAll<HTMLElement>('label')]);
 });
});

it('captures the open list over the table for the reporter (Classic, Atelier, Monolith)',async()=>{
 for(const theme of THEMES){
  await mount(theme);
  const list=await openList();
  expectTopmost(list,`${theme} capture`,options(list));
  // Saved beside the other browser captures (.vitest-attachments is gitignored); CI keeps none of them.
  const shot=await page.screenshot({path:`../.vitest-attachments/personnel-search-topmost-${theme}.png`,animations:'disabled',scale:'css'} as never);
  console.info('Personnel search topmost screenshot:',shot);
  cleanup();
 }
},120000);
