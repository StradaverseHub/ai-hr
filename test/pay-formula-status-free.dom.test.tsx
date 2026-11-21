import React from 'react';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import en from '../messages/en.json';
import {FormulaActions} from '../app/payroll/formula-builder/formula-actions';
import FormulaBuilderPage from '../app/payroll/formula-builder/page';
import type {FormulaBuilderView} from '../app/payroll/formula-builder/ui-types';
const state=vi.hoisted(()=>({list:vi.fn(async()=>[]),remove:vi.fn(),change:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn(),refresh:vi.fn()})}));
vi.mock('../lib/authz',()=>({requireAdmin:vi.fn(async()=>({tenantId:'tenant'}))}));
vi.mock('../packs/payroll/service',()=>({listPayFormulas:state.list,payFormulaOptions:vi.fn(async()=>({capabilities:{edit:true}}))}));
vi.mock('next-intl/server',()=>({getTranslations:vi.fn(async()=>((key:string)=>(en.payFormula as Record<string,unknown>)[key]??key))}));
vi.mock('../app/payroll/formula-builder/actions',()=>({deleteFormulaAction:state.remove,formulaStateAction:state.change}));
afterEach(cleanup);
it('ignores stale status query links and renders a status-free catalogue',async()=>{
 const element=await FormulaBuilderPage({searchParams:Promise.resolve({status:'draft',search:'OT'})});render(element);
 expect(state.list).toHaveBeenLastCalledWith({tenantId:'tenant'},{search:'OT',method:undefined});
 expect(screen.queryByRole('columnheader',{name:'Status'})).toBeNull();expect(screen.queryByRole('combobox',{name:'Status'})).toBeNull();expect(screen.getByRole('columnheader',{name:'Formula ID'})).toBeVisible();
});
it('does not offer activation even if a retained client fixture claims activation capabilities',()=>{
 const formula={id:'f',latest:{id:'r'},capabilities:{view:true,edit:true,test:true,activate:true,deactivate:true,delete:true}} as unknown as FormulaBuilderView;
 render(<NextIntlClientProvider locale="en" messages={en}><FormulaActions formula={formula}/></NextIntlClientProvider>);
 expect(screen.queryByRole('button',{name:en.payFormula.activate})).toBeNull();expect(screen.queryByRole('button',{name:en.payFormula.deactivate})).toBeNull();expect(screen.getByRole('button',{name:en.payFormula.delete})).toBeVisible();expect(state.change).not.toHaveBeenCalled();
});
