import {cleanup,render,screen} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({actions:{view:true,add:false,edit:false,delete:false}}));
vi.mock('next-intl/server',()=>({getTranslations:async()=>((key:string)=>key)}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');}}));
vi.mock('../lib/authz',()=>({requireAdmin:async()=>({tenantId:'fictional-tenant',roles:['hr_admin']})}));
vi.mock('../core/financial-setup-access',()=>({payrollCatalogueActions:async()=>state.actions}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:()=>false}));
vi.mock('../packs/payroll/service',()=>({payFormulaOptions:async()=>({activeFormulas:[]})}));
vi.mock('../localization/registry',()=>({packFor:()=>({eaReporting:[]})}));
vi.mock('../core/pay-components',()=>({listPayComponents:async()=>[],listPayRulePreviewCandidates:async()=>[],PAY_DISPLAY_CATEGORIES:[],ROUNDING_METHODS:[]}));
vi.mock('../app/admin/pay-components/actions',()=>({createComponentAction:vi.fn(),updateComponentAction:vi.fn()}));
vi.mock('../app/admin/pay-components/pay-rule-editor',()=>({PayRuleEditor:()=> <input aria-label="Calculation"/>}));
vi.mock('../app/admin/pay-components/orp-config',()=>({OrpConfig:()=> <input aria-label="Rate configuration"/>}));
vi.mock('../app/admin/pay-components/statutory-config',()=>({StatutoryConfig:()=> <input aria-label="Statutory configuration"/>}));
import {ComponentForm,type PayComponentRow} from '../app/admin/pay-components/component-form';
afterEach(()=>{cleanup();state.actions={view:true,add:false,edit:false,delete:false};});
const component={id:'fictional-code',code:'TEST',name:'Fictional retained item',rule:null,kind:'earning',archivedAt:null} as PayComponentRow;
describe('pay catalogue maintenance controls',()=>{
 it('keeps a retained item readable while disabling its fields and omitting save actions',async()=>{
  render(await ComponentForm({component,aiEnabled:false}));
  expect(screen.getByLabelText('Calculation').matches(':disabled')).toBe(true);
  expect(screen.getByDisplayValue('Fictional retained item').matches(':disabled')).toBe(true);
  expect(screen.queryByRole('button',{name:'saveChanges'})).toBeNull();
  expect(screen.getByRole('link',{name:'cancelEdit'})).toBeTruthy();
 });
 it('allows Add to edit a new form without enabling edits to a retained item',async()=>{
  state.actions={view:true,add:true,edit:false,delete:false};
  render(await ComponentForm({component:null,aiEnabled:false}));
  expect(screen.getByLabelText('Calculation').matches(':disabled')).toBe(false);
  expect(screen.getByRole('button',{name:'saveComponent'})).toBeTruthy();
 });
 it('refuses a new form without Add and refuses maintenance without View',async()=>{
  await expect(ComponentForm({component:null,aiEnabled:false})).rejects.toThrow('NOT_FOUND');
  state.actions={view:false,add:true,edit:true,delete:true};
  await expect(ComponentForm({component,aiEnabled:false})).rejects.toThrow('NOT_FOUND');
 });
});
