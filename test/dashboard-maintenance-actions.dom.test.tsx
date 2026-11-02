/** Actual library page with bounded fictional rows and independent canonical permissions. */
import {cleanup,render,screen} from '@testing-library/react';
import {createTranslator} from 'next-intl';
import {afterEach,it,expect,vi} from 'vitest';
import en from '../messages/en.json';import ms from '../messages/ms.json';import zh from '../messages/zh.json';
import ta from '../messages/ta.json';import th from '../messages/th.json';import viMessages from '../messages/vi.json';
const catalogues={en,ms,zh,ta,th,vi:viMessages};
const f=vi.hoisted(()=>({locale:'en' as keyof typeof catalogues,view:true,add:false,edit:false,delete:false,list:vi.fn()}));
vi.mock('next-intl/server',()=>({getTranslations:async(namespace:string)=>createTranslator({locale:f.locale,messages:catalogues[f.locale],namespace})}));
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>({s:{tenantId:'fictional',userId:'fictional-admin'}})}));
vi.mock('@/core/organisation-access',()=>({settingsActionAccess:async()=>({view:f.view,add:f.add,edit:f.edit,delete:f.delete})}));
vi.mock('@/core/dashboard-card-config',()=>({listCards:f.list,DASHBOARD_CARD_AUDIENCES:['employee'],DASHBOARD_CARD_TYPES:['information','action','shortcut']}));
vi.mock('@/components/employee-home/configuration-panel',()=>({HomeConfigurationPanel:()=>null}));
vi.mock('@/components/ui/confirm-submit',()=>({ConfirmSubmit:({children}:React.PropsWithChildren)=><button type="submit">{children}</button>}));
vi.mock('@/app/admin/settings/dashboard/actions',()=>({createCardAction:vi.fn(),updateCardAction:vi.fn(),setStatusAction:vi.fn(),deleteCardAction:vi.fn()}));
import Page from '../app/admin/settings/dashboard/page';
const row={id:'fictional-card',cardKey:'fixtureCard',name:'Fictional card',description:'Fictional bounded library row',cardType:'information',status:'active',employeeSelectable:true,defaultDisplay:true,mandatory:false,displayOrder:1,href:null,audience:['employee'],updatedAt:new Date('2026-01-01T00:00:00Z')};
afterEach(()=>{cleanup();vi.clearAllMocks();f.locale='en';f.view=true;f.add=false;f.edit=false;f.delete=false;});
it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('retains library rows and filters while mutation controls stay unavailable in %s',async locale=>{
 f.locale=locale;f.list.mockResolvedValue([row]);render(await Page({searchParams:Promise.resolve({edit:row.id})}));
 const t=catalogues[locale].dashboardCardConfig;
 expect(screen.getByText(row.name)).toBeTruthy();
 expect(screen.queryByRole('link',{name:t.createNew})).toBeNull();expect(screen.queryByRole('link',{name:t.edit})).toBeNull();
 expect(screen.queryByRole('button',{name:t.deactivate})).toBeNull();expect(screen.queryByRole('button',{name:t.delete})).toBeNull();
 expect(document.querySelector('form input[name="id"]')).toBeNull();
});
it('keeps Add and Delete independent of Edit',async()=>{
 f.add=true;f.delete=true;f.list.mockResolvedValue([row]);render(await Page({searchParams:Promise.resolve({new:'1'})}));
 expect(screen.getByRole('link',{name:en.dashboardCardConfig.createNew})).toBeTruthy();
 expect(screen.getByRole('button',{name:en.dashboardCardConfig.delete})).toBeTruthy();
 expect(screen.queryByRole('link',{name:en.dashboardCardConfig.edit})).toBeNull();expect(screen.queryByRole('button',{name:en.dashboardCardConfig.deactivate})).toBeNull();
 expect(screen.getByRole('textbox',{name:en.dashboardCardConfig.fieldKey})).toBeTruthy();
});
it('refuses revoked View before loading card sources or counts',async()=>{
 f.view=false;await expect(Page({searchParams:Promise.resolve({})})).rejects.toThrow('NOT_FOUND');expect(f.list).not.toHaveBeenCalled();
});
