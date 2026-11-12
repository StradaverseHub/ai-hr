import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import type { UserDirectoryRow } from '../app/admin/users/directory-model';
import '../app/globals.css';
import '../app/atelier.css';
vi.mock('../app/admin/actions',()=>({archiveUserAction:vi.fn(),assignRoleAction:vi.fn(),revokeInvitationAction:vi.fn(),revokeRoleAction:vi.fn(),setAssistantGrantAction:vi.fn()}));
vi.mock('../app/admin/users/[userId]/account/actions',()=>({accountAction:vi.fn(async()=>({status:'saved'})),generatePasswordAction:vi.fn(),accountHistoryAction:vi.fn(async()=>({status:'ok',entries:[]}))}));
const { UsersDirectory } = await import('../app/admin/users/users-directory');
const user=(key:string,name:string,change:Partial<UserDirectoryRow>={}):UserDirectoryRow=>({key,name,status:'active',personId:'person-'+key,email:key+'@example.test',appUserId:'user-'+key,loginSuffix:null,roles:[{id:key+'-role',role:'employee',companyId:null,company:null}],invitationId:null,invitedRole:null,invitedCompanyId:null,manuallyArchived:false,hasEmployment:true,employeeCode:'E-'+key.slice(0,4).toUpperCase(),...change});
const rows=[user('aisyah','Aisyah Rahman',{roles:[{id:'aisyah-hr',role:'hr_admin',companyId:'acme',company:'Acme Sdn Bhd'},{id:'aisyah-employee',role:'employee',companyId:null,company:null}]}),user('arjun','Arjun Kumar'),user('consultant','Alexandra Christina Consultant',{hasEmployment:false,employeeCode:null,email:'alexandra.christina.consultant@external-company.example.test'}),user('pending','Daniel Tan',{status:'pending',appUserId:null,roles:[]})];
const accounts={'user-aisyah':{username:'aisyah.r',status:'active',activeUntil:'2026-12-31',exemptionUntil:Date.UTC(2026,10,12,9,0),actions:['suspend','reactivate','expiry','temporary-password','recovery-exemption','recovery-exemption-cancel','reset-email']},'user-arjun':{username:'arjun.k',status:'active',activeUntil:null,actions:['suspend','reactivate','expiry','temporary-password','recovery-exemption','recovery-exemption-cancel','reset-email']},'user-consultant':{username:'alexandra.consultant',status:'suspended',activeUntil:null}};
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
describe('Users directory desktop/mobile experience',()=>{
 for(const width of [390,1280])for(const [locale,messages]of [['en',en],['ta',ta]]as const){
  it(`${locale} at ${width}px shows the account columns, labelled phone records and working row actions`,async()=>{
   await page.viewport(width,1100);document.documentElement.setAttribute('data-ui-theme','atelier');
   render(<NextIntlClientProvider locale={locale} messages={messages}><main className="mx-auto max-w-6xl p-4"><UsersDirectory rows={rows} accounts={accounts} lastSignIns={{'user-aisyah':'2026-11-10T01:30:00.000Z'}} groupAdmin includeArchived={false} companies={[{id:'acme',name:'Acme Sdn Bhd'}]} roleOptions={['employee','hr_admin']} assistantGrantedIds={['user-aisyah']}/></main></NextIntlClientProvider>);
   const d=messages.admin.users.directory;
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   const email=screen.getByText('alexandra.christina.consultant@external-company.example.test');
   expect(email.getBoundingClientRect().right).toBeLessThanOrEqual(email.closest('td')!.getBoundingClientRect().right+1);
   const first=[...document.querySelectorAll('[data-directory-row]')].find(row=>row.textContent?.includes('Aisyah Rahman')) as HTMLElement;
   const headings=[...first.closest('table')!.querySelectorAll('thead th')].map(heading=>heading.textContent?.trim());
   expect(headings).toEqual([d.employeeName,d.employeeId,d.username,d.email,d.accountStatus,d.role,d.companyScope,d.lastLogin,d.actions]);
   expect(within(first).getByText('10-Nov-2026 09:30')).toBeVisible();
   const pending=[...document.querySelectorAll('[data-directory-row]')].find(row=>row.textContent?.includes('Daniel Tan')) as HTMLElement;
   expect(within(pending).getByText(d.neverLoggedIn)).toBeVisible();
   expect(within(pending).getByRole('link',{name:d.setUsernamePassword})).toBeVisible();
   const cells=[...first.children] as HTMLElement[];
   if(width<768){
    // Stacked records: every value is labelled, and each cell sits inside the viewport.
    for(const [index,cell] of cells.slice(1).entries()){
     const label=cell.querySelector('span.block');expect(label?.textContent,`cell ${index+1}`).toBe(headings[index+1]);expect(label).toBeVisible();
     expect(cell.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    }
   }else{
    for(const cell of cells.slice(1))expect(cell.querySelector('span.block')).not.toBeVisible();
    const tops=cells.map(cell=>Math.round(cell.getBoundingClientRect().top));expect(new Set(tops).size).toBe(1);
   }
   for(const control of first.querySelectorAll('button,a'))expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(width<768?44:24);
   const actions=messages.accountManagement;
   expect(within(first).getByRole('button',{name:actions.resetPassword.open})).toBeVisible();
   expect(within(first).getByRole('button',{name:actions.authenticator.open})).toBeVisible();
   console.info('Users directory screenshot:',await page.screenshot({animations:'disabled',element:document.querySelector('main')!,path:`../.vitest-attachments/users-directory-${locale}-${width}.png`}));
   await page.getByRole('button',{name:actions.authenticator.open}).first().click();
   const dialog=await screen.findByRole('dialog');
   const box=dialog.getBoundingClientRect();expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width);
   expect(dialog.querySelector('input[name="until"]')).toBeVisible();
   console.info('Authenticator Control screenshot:',await page.screenshot({animations:'disabled',path:`../.vitest-attachments/users-authenticator-${locale}-${width}.png`}));
   await page.getByRole('button',{name:actions.dialogClose}).click();
   await page.getByRole('button',{name:d.edit}).first().click();
   const panel=screen.getByRole('region',{name:d.accessFor.replace('{name}','Aisyah Rahman')});
   expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.closest('td')!.getBoundingClientRect().bottom);
   expect(within(panel).getByRole('link',{name:d.securityHistory})).toBeVisible();
   console.info('User edit screenshot:',await page.screenshot({animations:'disabled',element:document.querySelector('main')!,path:`../.vitest-attachments/users-access-${locale}-${width}.png`}));
   await page.getByRole('combobox',{name:d.groupBy}).selectOptions('role');
   expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(3);
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
 }
});
