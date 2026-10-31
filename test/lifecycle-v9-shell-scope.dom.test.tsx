import {expect,it,vi} from 'vitest';
import {render,screen,fireEvent,within} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import messages from '../messages/en.json';
import {v9HtmlWorkspace,v9HtmlCase} from './helpers/v9-html-fixture';
vi.mock('next/navigation',()=>({useRouter:()=>({refresh:vi.fn(),push:vi.fn()})}));
vi.mock('../components/user-menu',()=>({UserMenu:()=> <button>Account menu</button>}));
vi.mock('../app/lifecycle/v9/actions',()=>({readV9Email:vi.fn(),readV9UpdatedEmail:vi.fn(),readV9Workflow:vi.fn(),readV9Case:vi.fn(),commandV9:vi.fn(),createV9Offboarding:vi.fn(),saveV9Config:vi.fn(),setupV9:vi.fn()}));
import {V9Workspace} from '../app/lifecycle/v9/workspace';
function workspace(scope:string[]|undefined,view:'leavers'|'records'|'offChecklists'='leavers') {
 const initial=v9HtmlWorkspace();initial.cases=['alpha','beta'].map(v9HtmlCase);
 return <NextIntlClientProvider locale="en" messages={messages}><V9Workspace initial={initial} viewer={{name:'Fictional HR',employeeCode:null,employed:false}} navigation="global" initialView={view} companyScope={scope}/></NextIntlClientProvider>;
}
it('uses the shell company projection without repeating company/account controls and responds to scope changes',()=>{
 const view=render(workspace(['alpha']));expect(screen.queryByRole('combobox',{name:'Company'})).toBeNull();expect(screen.queryByRole('button',{name:'Account menu'})).toBeNull();
 expect(screen.getByRole('button',{name:'Fictional alpha'})).toBeVisible();expect(screen.queryByRole('button',{name:'Fictional beta'})).toBeNull();
 fireEvent.change(screen.getByRole('textbox',{name:'Search cases'}),{target:{value:'EMP-alpha'}});expect(screen.getByRole('button',{name:'Fictional alpha'})).toBeVisible();
 fireEvent.change(screen.getByRole('textbox',{name:'Search cases'}),{target:{value:''}});
 view.rerender(workspace(['beta']));expect(screen.queryByRole('button',{name:'Fictional alpha'})).toBeNull();expect(screen.getByRole('button',{name:'Fictional beta'})).toBeVisible();
 view.rerender(workspace(['alpha','beta']));expect(screen.getByRole('button',{name:'Fictional alpha'})).toBeVisible();expect(screen.getByRole('button',{name:'Fictional beta'})).toBeVisible();
});
it.each([undefined,[],['foreign']])('does not widen absent, empty or foreign presentation scope %j',scope=>{
 render(workspace(scope));expect(screen.queryByRole('button',{name:'Fictional alpha'})).toBeNull();expect(screen.queryByRole('button',{name:'Fictional beta'})).toBeNull();expect(screen.getByText('No cases match your search or filters.')).toBeVisible();
});
it('narrows request records and checklist population using the same company projection',()=>{
 const view=render(workspace(['beta'],'records'));expect(screen.queryByText('Fictional alpha')).toBeNull();expect(screen.getByText('Fictional beta')).toBeVisible();
 view.rerender(workspace(['alpha'],'offChecklists'));fireEvent.click(screen.getByRole('button',{name:'Assignment rules'}));fireEvent.click(screen.getByText('Population preview · 1 of 1 match'));
 expect(screen.getByText('Fictional alpha')).toBeVisible();expect(screen.queryByText('Fictional beta')).toBeNull();
});
it('retains company/account/search functionality in the standalone workspace',()=>{
 render(<NextIntlClientProvider locale="en" messages={messages}><V9Workspace initial={v9HtmlWorkspace()} viewer={{name:'Fictional HR',employeeCode:null,employed:false}}/></NextIntlClientProvider>);
 expect(screen.getByRole('combobox',{name:'Company'})).toBeVisible();expect(screen.getByRole('button',{name:'Account menu'})).toBeVisible();expect(screen.getByRole('textbox',{name:'Search cases'})).toBeVisible();
});
it('keeps native joiners in the shell company selection and retains employee/case search in the existing list field',async()=>{
 const {blankCase,defaultConfig,progress}=await import('./helpers/v9-html-fixture');
 const today='2099-01-01',config=defaultConfig('fictional-hr'),env={today,now:today+'T02:00:00Z',id:()=> 'fictional-id',nextNumber:()=> 'IT-fictional',leave:{},taskLoads:{},lastTaskAssignment:{},pendingApprovals:{},lifetimeApprovals:{},users:[]};
 const rows=['alpha','beta'].map(id=>{const c=blankCase('native-'+id,'OB-'+id,'draft-'+id,{fullName:'Native '+id,employeeId:'EMP-'+id,joinDate:today,company:id},env);return {case:c,revision:1,isNew:false,progress:progress(config,c)};});
 const joiners={config,rows,options:{company:[],department:[],businessGroup:[],grade:[],title:[],employmentType:[],supervisor:[]}};
 const content=(scope:string[])=> <NextIntlClientProvider locale="en" messages={messages} timeZone="Asia/Kuala_Lumpur"><V9Workspace navigation="global" companyScope={scope} initialView="joiners" initial={v9HtmlWorkspace()} joiners={joiners} viewer={{name:'Fictional HR',employeeCode:null,employed:false}}/></NextIntlClientProvider>;
 const view=render(content(['alpha']));expect(screen.getByRole('link',{name:'Native alpha'})).toBeVisible();expect(screen.queryByRole('link',{name:'Native beta'})).toBeNull();
 view.rerender(content(['alpha','beta']));fireEvent.change(screen.getByRole('textbox',{name:'Search by name'}),{target:{value:'EMP-beta'}});expect(screen.getByRole('link',{name:'Native beta'})).toBeVisible();expect(screen.queryByRole('link',{name:'Native alpha'})).toBeNull();
 fireEvent.change(screen.getByRole('textbox',{name:'Search by name'}),{target:{value:'OB-alpha'}});expect(screen.getByRole('link',{name:'Native alpha'})).toBeVisible();expect(screen.queryByRole('link',{name:'Native beta'})).toBeNull();
});
