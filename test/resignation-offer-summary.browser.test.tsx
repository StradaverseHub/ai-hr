import {page} from 'vitest/browser';
import '../app/globals.css';
import '../app/atelier.css';
import {afterEach,beforeEach,expect,it} from 'vitest';
import {cleanup,render,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {Card} from '../components/ui';
import {ResignationOfferSummary} from '../components/resignation/common';
import type {ResignationCaseView} from '../lib/resignation-journey';

// Same employee Card spacing as EmployeeResignation: old mobile table columns had ~62px of text width.
const offerCase:ResignationCaseView={
 id:'fictional-case',number:'RSN-FICTIONAL',revision:7,employmentId:'fictional-employment',employeeName:'Fictional Employee',employeeCode:'F42',companyId:'fictional-company',companyName:'Fictional Company',businessGroup:'Fictional Group',department:'Engineering',position:'Engineering Supervisor',jobGrade:'G3',currentBasicSalary:'6800.00',currency:'SGD',stage:'offer',submittedOn:'2026-11-16',lastWorkingDay:'2026-12-16',reason:'Fictional example',noticeLabel:'1 month',earliestLastDay:'2026-12-16',
 offer:{position:'Engineering Superintendent',jobGrade:'G4',basicSalary:'7600.00',effectiveDate:'2027-01-01',justification:'Reviewed fictional terms'},offerReplyBy:'2026-11-20',offerWorkingDaysRemaining:2,offerReplyWarning:true,offerRemindOn:null,offerBlock:null,offboardingCaseId:null,replacementNeeded:null,replacementRequest:null,deciders:[],keptInLoop:[],decisionDueOn:null,comments:[],priorCases:[],attachments:[],letters:[],emails:[],tasks:[],blocked:[],capabilities:{withdraw:false,accept:false,offer:false,comment:false,retry:false},
};
const expectedTerms=[
 ['position','Position','Engineering Supervisor','Engineering Superintendent'],
 ['grade','Job Grade','G3','G4'],
 ['salary','Basic salary (per month) · SGD','SGD 6,800.00','SGD 7,600.00'],
] as const;
let previousTheme:string|null;
beforeEach(()=>{previousTheme=document.documentElement.getAttribute('data-ui-theme');document.documentElement.setAttribute('data-ui-theme','atelier');});
afterEach(()=>{cleanup();if(previousTheme===null)document.documentElement.removeAttribute('data-ui-theme');else document.documentElement.setAttribute('data-ui-theme',previousTheme);});
function view(value=offerCase){return <NextIntlClientProvider locale="en" messages={messages}><main className="mx-auto w-full max-w-4xl p-4"><Card className="space-y-4 p-5"><ResignationOfferSummary value={value}/></Card></main></NextIntlClientProvider>;}
function wholeWordBounds(element:HTMLElement,word:string){
 const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);let node:Node|null;
 while((node=walker.nextNode())){
  const offset=(node.textContent??'').indexOf(word);if(offset<0)continue;
  const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+word.length);
  const rectangles=Array.from(range.getClientRects()).filter(rect=>rect.width>0&&rect.height>0);
  // A text-node range produces one rectangle per visual line, so overflow-wrap splitting a word fails here.
  expect(rectangles,`${word} must remain a whole word at the actual viewport`).toHaveLength(1);
  const rect=rectangles[0],box=element.getBoundingClientRect();expect(rect.left).toBeGreaterThanOrEqual(box.left-1);expect(rect.right).toBeLessThanOrEqual(box.right+1);
  return rect;
 }
 throw new Error('Expected actual visible word '+word);
}

it.each([320,390,1440])('keeps retention terms readable and paired at %i pixels with the real Atelier table rules',async width=>{
 await page.viewport(width,1000);
 const rendered=render(view());await document.fonts.ready;
 const desktop=rendered.container.querySelector<HTMLTableElement>('[data-resignation-offer-desktop]')??rendered.container.querySelector<HTMLTableElement>('table');
 const mobile=rendered.container.querySelector<HTMLElement>('[data-resignation-offer-mobile]');
 const active=width<640&&mobile?mobile:desktop;if(!active)throw Error('Actual offer comparison missing');
 // Run the substantive geometry before requiring new markup: the old three-column mobile table fragments these words.
 const current=within(active).getByText('Engineering Supervisor'),proposed=within(active).getByText('Engineering Superintendent');
 wholeWordBounds(current,'Engineering');wholeWordBounds(proposed,'Engineering');wholeWordBounds(proposed,'Superintendent');
 for(const text of expectedTerms.flatMap(([,label,before,after])=>[label,before,after])){
  expect(within(active).getByText(text)).toBeVisible();
  expect(Array.from(rendered.container.querySelectorAll('*')).filter(element=>element.children.length===0&&element.textContent===text&&element.getClientRects().length>0),text+' renders once visibly').toHaveLength(1);
 }
 expect(active.scrollWidth).toBeLessThanOrEqual(active.clientWidth+1);
 expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth+1);
 const summary=active.closest('section');if(!summary)throw Error('Offer summary section missing');
 expect(within(summary).getByText('Effective date: 01-Jan-2027')).toBeVisible();
 expect(summary.querySelector('[data-offer-reply]')).toHaveTextContent('Reply by 20-Nov-2026');expect(summary.querySelector('[data-offer-reply]')).toHaveTextContent('2 working days left');
 expect(summary.textContent).not.toMatch(/MYR |RM /);
 if(width<640){
  expect(mobile).not.toBeNull();expect(mobile!).toBeVisible();expect(desktop!).not.toBeVisible();
  const terms=Array.from(mobile!.querySelectorAll<HTMLElement>('[data-offer-term]'));expect(terms.map(term=>term.dataset.offerTerm)).toEqual(expectedTerms.map(([key])=>key));
  for(const [index,term] of terms.entries()){
   const heading=term.querySelector<HTMLElement>(':scope > dt'),before=term.querySelector<HTMLElement>('[data-offer-value="current"]'),after=term.querySelector<HTMLElement>('[data-offer-value="proposed"]');
   if(!heading||!before||!after)throw Error('Full term and paired values missing');
   expect(heading).toHaveTextContent(expectedTerms[index][1]);expect(within(term).getByText('Current')).toBeVisible();expect(within(term).getByText('Proposed')).toBeVisible();
   expect(before).toHaveTextContent(expectedTerms[index][2]);expect(after).toHaveTextContent(expectedTerms[index][3]);
   const labelBox=heading.getBoundingClientRect(),beforeBox=before.getBoundingClientRect(),afterBox=after.getBoundingClientRect();
   expect(Math.abs(labelBox.width-term.getBoundingClientRect().width)).toBeLessThan(2);
   expect(beforeBox.top).toBeGreaterThanOrEqual(labelBox.bottom);expect(afterBox.top).toBeGreaterThanOrEqual(labelBox.bottom);
   if(width<360){
    // Very narrow phones keep each labelled value full-width; never split ordinary job words to retain two columns.
    expect(Math.abs(beforeBox.width-labelBox.width)).toBeLessThan(2);expect(Math.abs(afterBox.width-labelBox.width)).toBeLessThan(2);
    expect(Math.abs(beforeBox.left-afterBox.left)).toBeLessThan(2);expect(afterBox.top).toBeGreaterThan(beforeBox.bottom);
   }else{
    expect(labelBox.width).toBeGreaterThan(beforeBox.width+afterBox.width);expect(beforeBox.left).toBeLessThan(afterBox.left);
   }
  }
 }else{
  expect(desktop!).toBeVisible();expect(mobile!).not.toBeVisible();
  const headings=Array.from(desktop!.querySelectorAll('thead th'));expect(headings.map(cell=>cell.textContent)).toEqual(['Term','Current','Proposed']);
  const headerBounds=headings.map(cell=>cell.getBoundingClientRect());expect(headerBounds[0].left).toBeLessThan(headerBounds[1].left);expect(headerBounds[1].left).toBeLessThan(headerBounds[2].left);
  for(const row of Array.from(desktop!.querySelectorAll('tbody tr'))){const cells=Array.from(row.children);expect(cells).toHaveLength(3);for(const [index,cell]of cells.entries())expect(Math.abs(cell.getBoundingClientRect().left-headerBounds[index].left)).toBeLessThan(2);}
 }
 await page.screenshot({path:`../.vitest-attachments/retention-offer-summary-${width}.png`,animations:'disabled',scale:'css'});
 // Presentation changes cannot reveal the same offer before release or render a missing offer.
 rendered.rerender(view({...offerCase,stage:'retention'}));expect(rendered.container.querySelector('table, [data-resignation-offer-mobile], [data-offer-reply]')).toBeNull();
 rendered.rerender(view({...offerCase,offer:null}));expect(rendered.container.querySelector('table, [data-resignation-offer-mobile], [data-offer-reply]')).toBeNull();
});
