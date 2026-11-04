/** Real Chromium/Tailwind library and registration screenshots; metadata-only fictional catalogue. */
import {afterEach,describe,it,expect,vi} from 'vitest';
import {cleanup,render,screen,fireEvent} from '@testing-library/react';
import {page} from 'vitest/browser';
import {NextIntlClientProvider} from 'next-intl';
import '../app/globals.css';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
import {personnelFormulaLibraryFixture} from './pay-formula-personnel-fixture';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn()})}));
vi.mock('../app/payroll/formula-builder/actions',()=>({registerPersonnelFormulaFieldAction:vi.fn(async()=>({ok:true,value:{saved:true}}))}));
const {PersonnelFormulaLibrary}=await import('../app/payroll/formula-builder/personnel-library');
const catalogues={en,ms,zh,ta,th,vi:viMessages};
afterEach(()=>{cleanup();document.body.style.margin='';document.documentElement.removeAttribute('data-ui-theme');});
for(const [locale,messages]of Object.entries(catalogues))describe(`Personnel formula library ${locale}`,()=>{
 for(const width of [390,1440])it(`renders and captures the real library and registry at ${width}px`,async()=>{
  await page.viewport(width,900);document.body.style.margin='0';document.documentElement.setAttribute('data-ui-theme','atelier');
  render(<NextIntlClientProvider locale={locale} messages={messages}><main data-testid="personnel-library-capture" className="mx-auto max-w-3xl space-y-4 p-4"><h1 className="text-xl font-semibold">{messages.payFormula.variables}</h1><section className="min-w-0 rounded-xl border border-border bg-card p-4"><PersonnelFormulaLibrary fields={personnelFormulaLibraryFixture()} search="" category="" disabled={false} onInsert={()=>{}}/></section></main></NextIntlClientProvider>);
  await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
  const main=screen.getByTestId('personnel-library-capture');expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);expect(main.getBoundingClientRect().width).toBeLessThanOrEqual(width);
  const insert=screen.getAllByRole('button',{name:messages.payFormula.personnelLibrary.insertField});expect(insert.some(button=>(button as HTMLButtonElement).disabled)).toBe(true);expect(insert.some(button=>!(button as HTMLButtonElement).disabled)).toBe(true);
  await page.screenshot({element:main,path:`../.vitest-attachments/personnel-library-${locale}-${width}.png`,animations:'disabled',scale:'css'});
  fireEvent.click(screen.getByRole('button',{name:messages.payFormula.personnelLibrary.register}));
  expect(screen.getByRole('combobox',{name:messages.payFormula.personnelLibrary.source})).toBeVisible();expect(screen.getByRole('checkbox',{name:messages.payFormula.personnelLibrary.enabled})).toBeChecked();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  await page.screenshot({element:main,path:`../.vitest-attachments/personnel-registry-${locale}-${width}.png`,animations:'disabled',scale:'css'});
 });
});
