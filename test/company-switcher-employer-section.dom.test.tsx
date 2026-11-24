import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
vi.mock('next/navigation',()=>({usePathname:()=> '/people'}));
vi.mock('next-intl',()=>({useTranslations:()=> (key:string,values?:{count:number})=>key==='companyCount'?`${values?.count} companies`:key}));
vi.mock('@/app/scope-actions',()=>({setCompanyScope:vi.fn()}));
vi.mock('@/components/ui-theme-context',()=>({useIsMonolith:()=>false}));
import {CompanySwitcher} from '../components/company-switcher';
afterEach(cleanup);

const assigned=[{id:'c1',name:'Fictional Cement',access:'role' as const},{id:'c2',name:'Fictional Concrete',access:'role' as const}];
const employer={id:'c0',name:'Fictional Building Materials',access:'employment' as const};

it('lists the employer company apart, labelled as own records only, beside the assigned companies',async()=>{
 render(<CompanySwitcher companies={[employer,...assigned]} selected={['c0','c1','c2']}/>);
 await userEvent.click(screen.getByRole('button',{name:/allCompanies/}));
 const section=screen.getByRole('group',{name:'employerCompanies'});
 expect(within(section).getByText('employerCompaniesHint')).toBeInTheDocument();
 expect(within(section).getAllByRole('checkbox').map(box=>(box as HTMLInputElement).value)).toEqual(['c0']);
 const boxes=screen.getAllByRole('checkbox').map(box=>(box as HTMLInputElement).value);
 expect(boxes).toEqual(['c1','c2','c0']);
});

it('keeps one plain list when no company is employment-only',async()=>{
 render(<CompanySwitcher companies={assigned} selected={['c1','c2']}/>);
 await userEvent.click(screen.getByRole('button',{name:/allCompanies/}));
 expect(screen.queryByRole('group',{name:'employerCompanies'})).toBeNull();
 expect(screen.queryByText('employerCompaniesHint')).toBeNull();
 expect(screen.getAllByRole('checkbox')).toHaveLength(2);
});

it('keeps one plain list for a user whose only company is their employer',async()=>{
 render(<CompanySwitcher companies={[employer]} selected={['c0']}/>);
 await userEvent.click(screen.getByRole('button',{name:/allCompanies/}));
 expect(screen.queryByRole('group',{name:'employerCompanies'})).toBeNull();
 expect(screen.getAllByRole('checkbox')).toHaveLength(1);
});
