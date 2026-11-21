/**
 * aa045103 regression (owner, 12 Nov) — on Personnel Management, typing "irwi" opened a suggestion list whose
 * left part sat behind the sidebar ("…G EMPLOYEES", names cut to "w"). The list was `right-0` and 24rem wide
 * under an 18rem box, so it reached 6rem LEFT of the box; with the box at the content area's left edge,
 * <main> (overflow-y-auto, hence overflow-x auto) clipped that part. The Department/Status column filters had
 * the same end-aligned rule (left = trigger.right − 288), which opens over the sidebar from a narrow first
 * column.
 *
 * Round 2 (the reporter refuted the first build: the list was still covered by the top menu bar): the list is
 * now PORTALED to <body> and `position: fixed` through components/ui/anchored-panel.tsx, so neither the sticky
 * page header's stacking context nor <main>'s overflow box can cover or clip it. That it is truly topmost is a
 * real-browser question: test/personnel-search-dropdown-topmost.browser.test.tsx probes it with
 * elementFromPoint in all three themes. This file pins the placement maths and the combobox contract.
 *
 * jsdom has no layout, so each case installs the rects it is about: a content area (<main>, overflow auto)
 * that starts right of a 240px sidebar, and a box / trigger inside it. Every assertion is "never left of the
 * box / trigger / content edge, never past the content's right edge".
 */
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {PersonnelListSearch,suggestionListWidth,SUGGESTION_LIST_WIDTH} from '../app/admin/personnel/list-search';
import {PersonnelAutoFilters} from '../app/admin/personnel/auto-filter';
import {ColumnChoiceFilter} from '../app/admin/personnel/column-choice-filter';
import {startAlignedLeft,visibleHorizontalBounds} from '../components/ui/anchored-panel';

vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),replace:vi.fn(),push:vi.fn()})}));
type Box={left:number;right:number;top?:number;bottom?:number};
const rect=({left,right,top=100,bottom=136}:Box)=>({left,right,top,bottom,width:right-left,height:bottom-top,x:left,y:top,toJSON:()=>({})}) as DOMRect;
/** Rects by element: <main> is the content area; `anchor` is the search box wrapper or the column trigger. */
function layout(main:Box,anchor:(el:HTMLElement)=>Box|null){
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
  if(this.tagName==='MAIN')return rect(main);
  return rect(anchor(this)??{left:0,right:0});
 });
 // clientWidth is the content box (no scrollbar): the main element's own width here.
 vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockImplementation(function(this:HTMLElement){return this.tagName==='MAIN'?main.right-main.left:0;});
}
const suggestions=[{employmentId:'fixture-1',name:'Fictional Irwin Tan',employeeCode:'EMP-0001',company:'Fictional Alpha Sdn Bhd',department:'Finance'},
 {employmentId:'fixture-2',name:'Fictional Irwina Lim',employeeCode:'EMP-0002',company:'Fictional Alpha Sdn Bhd',department:'HR'}];
beforeEach(()=>{vi.stubGlobal('fetch',vi.fn(async()=>Response.json({rows:suggestions})));});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

const box=()=>screen.getByRole('combobox',{name:en.people.switcher.ariaLabel});
const mountSearch=()=>render(<NextIntlClientProvider locale="en" messages={en}><main style={{overflowY:'auto',overflowX:'auto'}}>
 <PersonnelAutoFilters><PersonnelListSearch pageSize="50" parameters={[]}/></PersonnelAutoFilters></main></NextIntlClientProvider>);
const openList=async()=>{
 fireEvent.change(box(),{target:{value:'irwi'}});
 const list=await screen.findByRole('listbox',{name:en.people.switcher.resultsLabel});
 await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(3));
 return list;
};
const boxWrapper=(el:HTMLElement)=>el.querySelector(':scope > input[role="combobox"]')?el:null;

it('portals the suggestion list to <body> as a fixed panel opening from the box LEFT edge, at its preferred 24rem when there is room',async()=>{
 Object.defineProperty(window,'innerHeight',{configurable:true,value:900});
 // Desktop: sidebar 0–240, content 240–1280, the box at the content's left edge (as when the header wraps).
 layout({left:240,right:1280},el=>boxWrapper(el)?{left:256,right:544}:null);
 mountSearch();
 const list=await openList();
 // Out of the sticky header and out of <main>: a direct child of <body>, fixed and on the top layer.
 expect(list.parentElement).toBe(document.body);
 expect(document.querySelector('main')!.contains(list)).toBe(false);
 expect(list).toHaveClass('fixed','z-50');
 expect(list.className).not.toMatch(/(^|\s)(absolute|right-0)(\s|$)/);
 expect(list.style.left).toBe('256px');
 expect(list.style.top).toBe('140px'); // the box bottom (136) + a 4px gap, opening downwards
 expect(list.style.transform).toBe('');
 expect(list.style.width).toBe(SUGGESTION_LIST_WIDTH+'px');
 expect(Number.parseFloat(list.style.maxHeight)).toBeLessThanOrEqual(384);
 // Keyboard and aria are unchanged by the fix.
 expect(box()).toHaveAttribute('aria-controls',list.id);
 expect(list).toHaveAttribute('role','listbox');
 fireEvent.keyDown(box(),{key:'ArrowDown'});
 expect(box()).toHaveAttribute('aria-activedescendant',screen.getAllByRole('option')[0].id);
 expect(screen.getAllByRole('option')[0].id.startsWith(list.id)).toBe(true);
 // Enter on the active option applies that person's Employee ID and closes the list.
 fireEvent.keyDown(box(),{key:'Enter'});
 expect(box()).toHaveValue('EMP-0001');
 expect(screen.queryByRole('listbox')).toBeNull();
});

it('a click on a portaled option applies the term; focus moving into the list does not close it; Escape does',async()=>{
 layout({left:240,right:1280},el=>boxWrapper(el)?{left:256,right:544}:null);
 mountSearch();
 let list=await openList();
 // Focus landing INSIDE the portaled list is not a blur of the combobox (it is outside the box in the DOM).
 fireEvent.blur(box(),{relatedTarget:list});
 expect(screen.getByRole('listbox')).toBe(list);
 // A blur to anywhere else closes it.
 fireEvent.blur(box(),{relatedTarget:document.body});
 expect(screen.queryByRole('listbox')).toBeNull();
 fireEvent.focus(box());
 list=await screen.findByRole('listbox');
 fireEvent.keyDown(box(),{key:'Escape'});
 expect(screen.queryByRole('listbox')).toBeNull();
 fireEvent.change(box(),{target:{value:'irwin'}});
 list=await screen.findByRole('listbox');
 await waitFor(()=>expect(screen.getAllByRole('option')).toHaveLength(3));
 const option=screen.getAllByRole('option')[1];
 // mousedown keeps focus in the box (default prevented), then the click picks.
 expect(fireEvent.mouseDown(option)).toBe(false);
 expect(fireEvent.mouseDown(list)).toBe(false);
 fireEvent.click(option);
 expect(box()).toHaveValue('EMP-0002');
 expect(screen.queryByRole('listbox')).toBeNull();
});

it('opens UPWARDS and caps its height to the room left when the box sits near the bottom of the window',async()=>{
 Object.defineProperty(window,'innerHeight',{configurable:true,value:560});
 layout({left:240,right:1280},el=>boxWrapper(el)?{left:256,right:544,top:480,bottom:516}:null);
 mountSearch();
 const list=await openList();
 expect(list.style.transform).toBe('translateY(-100%)');
 expect(list.style.top).toBe('476px'); // box top − 4px gap; the panel's bottom edge sits there
 expect(Number.parseFloat(list.style.maxHeight)).toBeLessThanOrEqual(480-4-8);
 Object.defineProperty(window,'innerHeight',{configurable:true,value:900});
});

it('narrows to the room left in the content area, but never below the box width', async()=>{
 // A box near the right edge of a 1024px window with the sidebar open: 120px+ short of 24rem.
 layout({left:240,right:1024},el=>boxWrapper(el)?{left:700,right:988}:null);
 mountSearch();
 const list=await openList();
 expect(list.style.width).toBe('316px'); // 1024 − 700 − 8 gutter
 cleanup();vi.restoreAllMocks();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({rows:suggestions})));
 // Phone: content 0–375, a 208px box at 151 — the room (216) is still at least the box, so it fits exactly.
 layout({left:0,right:375},el=>boxWrapper(el)?{left:151,right:359}:null);
 mountSearch();
 expect((await openList()).style.width).toBe('216px');
});

it('suggestionListWidth: left-anchored width is clamp(box width, 24rem, room to the right)',()=>{
 expect(suggestionListWidth({left:256,width:288},{right:1280})).toBe(384);
 expect(suggestionListWidth({left:700,width:288},{right:1024})).toBe(316);
 expect(suggestionListWidth({left:740,width:288},{right:1024})).toBe(288);
});

it('column filter panels open from the trigger LEFT edge and stay inside the content area', ()=>{
 Object.defineProperty(window,'innerWidth',{configurable:true,value:1280});
 Object.defineProperty(window,'innerHeight',{configurable:true,value:900});
 const options=[{value:'finance',label:'Finance'},{value:'hr',label:'Human Resources'}];
 const name='Department';
 const label=en.people.list.controls.filterColumn.replace('{name}',name);
 const mount=()=>render(<NextIntlClientProvider locale="en" messages={en}><main style={{overflowY:'auto',overflowX:'auto'}}>
  <ColumnChoiceFilter name={name} param="dept" options={options} selected={[]} parameters={[]} pageSize="50"/></main></NextIntlClientProvider>);
 // A 128px first-column trigger at the content's left edge (260). The old end-aligned rule put the panel at
 // 388 − 288 = 100: over the 240px sidebar.
 layout({left:240,right:1280},el=>el.getAttribute('aria-haspopup')==='dialog'?{left:260,right:388}:null);
 mount();
 fireEvent.click(screen.getByRole('button',{name:label}));
 const panel=screen.getByRole('dialog',{name:label});
 expect(panel.style.left).toBe('260px');
 cleanup();vi.restoreAllMocks();
 // A trigger near the right edge shifts left just enough to fit, never past the content's left edge.
 layout({left:240,right:1280},el=>el.getAttribute('aria-haspopup')==='dialog'?{left:1150,right:1270}:null);
 mount();
 fireEvent.click(screen.getByRole('button',{name:label}));
 expect(screen.getByRole('dialog',{name:label}).style.left).toBe(String(1280-288-8)+'px');
});

it('startAlignedLeft and visibleHorizontalBounds clamp to the clipping ancestor, not the window',()=>{
 expect(startAlignedLeft({left:260},{left:240,right:1280},288)).toBe(260);
 expect(startAlignedLeft({left:1150},{left:240,right:1280},288)).toBe(984);
 // Content too narrow for the panel: pinned to the content's left edge, never under the sidebar.
 expect(startAlignedLeft({left:250},{left:240,right:400},288)).toBe(240);
 layout({left:240,right:1024},()=>null);
 const {container}=render(<main style={{overflowX:'auto'}}><div><span id="anchor"/></div></main>);
 expect(visibleHorizontalBounds(container.querySelector('#anchor') as HTMLElement)).toEqual({left:240,right:1024});
});

it('with no layout box to measure (a static capture), the list carries no guessed inline width',async()=>{
 mountSearch();
 const list=await openList();
 expect(list.style.width).toBe('');expect(list.parentElement).toBe(document.body);
});
