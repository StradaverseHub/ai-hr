/** Real browser/CSS with fictional scoped projections; companion DB tests establish authorization. */
import {afterEach,it,expect,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {page} from 'vitest/browser';
import en from '../messages/en.json';
import {CompanyRows} from '../app/admin/organization/company-rows';
import '../app/globals.css';
import '../app/atelier.css';
afterEach(cleanup);
const labels={active:'Active',archived:'Archived',empty:'No matching companies',view:'View',edit:'Edit',archive:'Archive',unarchive:'Unarchive',registration:en.admin.organization.registration};
it('keeps the registration number adjacent to a readable status and a direct Complete action on desktop and mobile',async()=>{
 const oldTheme=document.documentElement.getAttribute('data-ui-theme');document.documentElement.setAttribute('data-ui-theme','atelier');try{
 for(const width of [1280,390]){await page.viewport(width,900);const result=render(<NextIntlClientProvider locale="en" messages={en}><main data-ui-theme="atelier" className="p-4"><h1 className="mb-4 text-xl font-semibold">Companies · statutory registration</h1><div className="max-w-full overflow-x-auto"><table className="w-full text-sm"><thead><tr>{['Code','Legal name','Reg. no.','Statutory','Parent company','Status','Actions'].map(t=><th key={t} className="p-3 text-left">{t}</th>)}</tr></thead><tbody><CompanyRows labels={labels} archiveAction={vi.fn()} rows={[{id:'demo-a',code:'DEMO-A',name:'Sample employer with a long legal name',registrationNo:null,parentId:'demo-group',parentName:'Sample business group',archived:false,statutoryStatus:'missing'},{id:'demo-b',code:'DEMO-B',name:'Sample complete employer',registrationNo:'EXAMPLE-002',parentId:null,parentName:null,archived:false,statutoryStatus:'complete'},{id:'demo-group',code:null,name:'Sample grouping node',registrationNo:null,parentId:null,parentName:null,archived:false,statutoryStatus:'not_required'}]}/></tbody></table></div></main></NextIntlClientProvider>);
  expect(screen.getByText('Missing')).toBeVisible();expect(screen.getByText('Not required')).toBeVisible();const complete=screen.getByRole('link',{name:'Complete'});expect(complete).toHaveAttribute('href','/admin/organization/demo-a?tab=statutory');complete.focus();expect(document.activeElement).toBe(complete);const main=document.querySelector('main')!;expect(main.getBoundingClientRect().width).toBeLessThanOrEqual(width);const image=await page.screenshot({element:main,path:`../.vitest-attachments/company-registration-${width}.png`,animations:'disabled',base64:true,scale:'css'});console.info('COMPANY_REGISTRATION_SCREENSHOT '+JSON.stringify({width,source:'fictional-scoped-projection',base64:image.base64}));result.unmount();
 }
 }finally{if(oldTheme===null)document.documentElement.removeAttribute('data-ui-theme');else document.documentElement.setAttribute('data-ui-theme',oldTheme);}
});
