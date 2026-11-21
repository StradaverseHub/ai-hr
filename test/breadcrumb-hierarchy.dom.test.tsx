import React from 'react';
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,within,cleanup} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
const state=vi.hoisted(()=>({path:'/admin/loans/fictional',search:'employmentId=fictional'}));
vi.mock('next/navigation',()=>({usePathname:()=>state.path,useSearchParams:()=>new URLSearchParams(state.search)}));
vi.mock('../components/ui-theme-context',()=>({useIsMonolith:()=>false,useUiTheme:()=>'atelier'}));
vi.mock('../components/company-switcher',()=>({companyScopeLabel:()=>''}));
vi.mock('../components/nav-index-context',()=>({useNavIndex:()=>({active:null,entries:[{href:'/payroll/transactions',label:'Transaction Entry',section:'Ops',parent:'Payroll',parentHref:null},{href:'/reports',label:'Reports',section:null,parent:null,parentHref:null}]})}));
import {ShellRoutePath} from '../components/shell-top-line';
afterEach(cleanup);
function Fixture(){return <NextIntlClientProvider locale="en" messages={en}><ShellRoutePath/><div data-app-content><main><h1>Fictional loan</h1></main></div></NextIntlClientProvider>;}
it('renders the previously absent loan trail with a scoped list and an unlinked module heading',async()=>{
 render(<Fixture/>);const crumb=screen.getByRole('navigation',{name:en.topbar.breadcrumb});
 expect(within(crumb).queryByRole('link',{name:'Payroll'})).toBeNull();
 expect(within(crumb).getByRole('link',{name:'Transaction Entry'})).toHaveAttribute('href','/payroll/transactions');
 expect(within(crumb).getByRole('link',{name:'Loans'})).toHaveAttribute('href','/admin/loans?employmentId=fictional');
 expect(await within(crumb).findByText('Fictional loan')).toHaveAttribute('aria-current','page');
});
it('follows same-path starter transitions and replaces the final heading as content streams',async()=>{
 state.path='/reports/employee-master/new';state.search='starter=resigned';
 const view=render(<Fixture/>);const crumb=screen.getByRole('navigation',{name:en.topbar.breadcrumb});
 expect(within(crumb).getByRole('link',{name:'Employee Master reports'})).toHaveAttribute('href','/reports/employee-master');
 document.querySelector('main h1')!.textContent='Resigned employees';
 expect(await within(crumb).findByText('Resigned employees')).toHaveAttribute('aria-current','page');
 state.search='starter=contractExpiry';view.rerender(<Fixture/>);
 document.querySelector('main h1')!.textContent='Contract expiry';
 expect(await within(crumb).findByText('Contract expiry')).toHaveAttribute('aria-current','page');
});
