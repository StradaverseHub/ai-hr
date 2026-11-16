import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../messages/en.json';
import { PayrollSelectionSearch } from '../app/payroll/selection-search';
const nav=vi.hoisted(()=>({replace:vi.fn(),query:'page=3&newPage=4&size=50&newSize=100&from=review&job=abc'}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:nav.replace}),usePathname:()=>'/payroll/b1/reprocess',useSearchParams:()=>new URLSearchParams(nav.query)}));
beforeEach(()=>nav.replace.mockClear());
it('searches once on Enter, preserves context and page sizes, resets both pages and never submits payroll',async()=>{
 const user=userEvent.setup(),submit=vi.fn(e=>e.preventDefault());
 render(<NextIntlClientProvider locale="en" messages={messages}><form onSubmit={submit}>
  <PayrollSelectionSearch query="" placeholder="Find employee"/>
 </form></NextIntlClientProvider>);
 await user.type(screen.getByRole('searchbox'),' EMP0007 ');
 expect(nav.replace).not.toHaveBeenCalled();
 await user.keyboard('{Enter}');
 expect(submit).not.toHaveBeenCalled();expect(nav.replace).toHaveBeenCalledTimes(1);
 const [href,options]=nav.replace.mock.calls[0];const url=new URL(href,'https://fixture.test');
 expect(url.pathname).toBe('/payroll/b1/reprocess');
 expect(Object.fromEntries(url.searchParams)).toEqual({size:'50',newSize:'100',from:'review',job:'abc',q:'EMP0007'});
 expect(options).toEqual({scroll:false});
});
it('clears the server search using a non-submit Search button',async()=>{
 const user=userEvent.setup(),submit=vi.fn(e=>e.preventDefault());nav.query='q=old&page=1&newPage=2';
 render(<NextIntlClientProvider locale="en" messages={messages}><form onSubmit={submit}>
  <PayrollSelectionSearch query="old" placeholder="Find employee"/>
 </form></NextIntlClientProvider>);
 await user.clear(screen.getByRole('searchbox'));await user.click(screen.getByRole('button',{name:'Search'}));
 expect(nav.replace).toHaveBeenCalledWith('/payroll/b1/reprocess',{scroll:false});expect(submit).not.toHaveBeenCalled();
});
