import {afterEach,describe,expect,it} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,render} from '@testing-library/react';
import {EmployeeName,Field,inputCls} from '../components/ui';
import {PieChart} from '../components/charts/PieChart';
import {InquiryScopeSummary} from '../components/leave/inquiry-scope-summary';
import '../app/globals.css';
import '../app/atelier.css';
import '../app/operational-layout.css';

afterEach(()=>{cleanup();delete document.documentElement.dataset.uiTheme;});

describe('operational spacing in the browser',()=>{
 it('keeps a two-row explanation taller than a single-line field in both themes',()=>{
  for(const theme of ['default','atelier']){
   document.documentElement.dataset.uiTheme=theme;
   const view=render(<div style={{width:320}}><Field label="Explanation"><textarea className={inputCls} rows={2} defaultValue={'First line\nSecond line'}/></Field><input className={inputCls} aria-label="Single line"/></div>);
   const textarea=view.getByLabelText('Explanation'),input=view.getByLabelText('Single line');
   expect(textarea.getBoundingClientRect().height).toBeGreaterThanOrEqual(80);
   expect(textarea.getBoundingClientRect().height).toBeGreaterThan(input.getBoundingClientRect().height);
   expect(textarea.scrollHeight).toBeLessThanOrEqual(textarea.clientHeight+1);
   view.unmount();
  }
  delete document.documentElement.dataset.uiTheme;
 });
 it('preserves a visible code/name gap in the bounded employee picker row',()=>{
  const view=render(<div style={{width:260}}><EmployeeName code="EMP-0003" name="Fictional employee with a long name" className="flex truncate font-medium text-foreground"/></div>);
  const name=view.getByText('Fictional employee with a long name'),code=view.getByText('EMP-0003');
  expect(name.getBoundingClientRect().left-code.getBoundingClientRect().right).toBeGreaterThanOrEqual(5.5);
  expect(name.getBoundingClientRect().right).toBeLessThanOrEqual(code.parentElement!.getBoundingClientRect().right+1);
  expect(code.getBoundingClientRect().height).toBeLessThan(30);
 });
 it('keeps a large scope compact while retaining every company in its disclosure',()=>{
  const companies=Array.from({length:40},(_,i)=>({id:String(i),name:`Fictional company ${i+1}`}));
  const view=render(<div style={{width:320}}><InquiryScopeSummary heading="42 employees · 40 companies" companies={companies}/></div>);
  const summary=view.getByText('42 employees · 40 companies'),details=summary.closest('details')!;
  expect(details.getBoundingClientRect().height).toBeLessThan(60);
  summary.click();
  expect(details.open).toBe(true);
  expect(details.querySelectorAll('li')).toHaveLength(40);
  expect(view.getByText('Fictional company 40')).toBeVisible();
  expect(details.getBoundingClientRect().height).toBeLessThan(260);
 });
 it('retains readable pie legends and a scroll boundary on narrow screens',async()=>{
  const view=render(<main style={{width:320,padding:16}}><PieChart id="coverage-fixture" data={[{label:'Recorded',value:12},{label:'Unknown',value:28}]}/></main>);
  const svg=view.container.querySelector('svg')!,legend=svg.querySelector('text')!;
  expect(svg.getBoundingClientRect().width).toBeGreaterThanOrEqual(480);
  expect(svg.parentElement!.scrollWidth).toBeGreaterThan(svg.parentElement!.clientWidth);
  expect(legend.getBoundingClientRect().height).toBeGreaterThanOrEqual(12);
  await page.screenshot({element:view.container,path:'../.vitest-attachments/operational-layout-mobile.png',animations:'disabled'});
 });
});
