import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import type { UserDirectoryRow } from '../app/admin/users/directory-model';
import '../app/globals.css';
import '../app/atelier.css';
const { UsersDirectory } = await import('../app/admin/users/users-directory');
const user=(key:string,name:string,change:Partial<UserDirectoryRow>={}):UserDirectoryRow=>({key,name,status:'active',personId:'person-'+key,email:key+'@example.test',appUserId:'user-'+key,loginSuffix:null,roles:[{id:key+'-role',role:'employee',companyId:null,company:null}],invitationId:null,invitedRole:null,invitedCompanyId:null,manuallyArchived:false,hasEmployment:true,employeeCode:'E-'+key.slice(0,4).toUpperCase(),...change});
const rows=[user('aisyah','Aisyah Rahman',{roles:[{id:'aisyah-hr',role:'hr_admin',companyId:'acme',company:'Acme Sdn Bhd'},{id:'aisyah-employee',role:'employee',companyId:null,company:null}]}),user('arjun','Arjun Kumar'),user('consultant','Alexandra Christina Consultant',{hasEmployment:false,employeeCode:null,email:'alexandra.christina.consultant@external-company.example.test'}),user('pending','Daniel Tan',{status:'pending',appUserId:null,roles:[]})];
const accounts={'user-aisyah':{username:'aisyah.r',status:'active',activeUntil:'2026-12-31',exemptionUntil:Date.now()+3*24*3600_000},'user-arjun':{username:'arjun.k',status:'active',activeUntil:null},'user-consultant':{username:'alexandra.consultant',status:'suspended',activeUntil:null}};
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
describe('Users directory desktop/mobile experience',()=>{
 for(const width of [390,1280])for(const [locale,messages]of [['en',en],['ta',ta]]as const){
  it(`${locale} at ${width}px shows the account columns with User Type, labelled phone records and one View/Edit per row`,async()=>{
   await page.viewport(width,1100);document.documentElement.setAttribute('data-ui-theme','atelier');
   render(<NextIntlClientProvider locale={locale} messages={messages}><main className="mx-auto max-w-6xl p-4"><UsersDirectory rows={rows} accounts={accounts} lastSignIns={{'user-aisyah':'2026-11-10T01:30:00.000Z'}} groupAdmin includeArchived={false} companies={[{id:'acme',name:'Acme Sdn Bhd'}]}/></main></NextIntlClientProvider>);
   const d=messages.admin.users.directory;
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   const email=screen.getByText('alexandra.christina.consultant@external-company.example.test');
   expect(email.getBoundingClientRect().right).toBeLessThanOrEqual(email.closest('td')!.getBoundingClientRect().right+1);
   const first=[...document.querySelectorAll('[data-directory-row]')].find(row=>row.textContent?.includes('Aisyah Rahman')) as HTMLElement;
   const headings=[...first.closest('table')!.querySelectorAll('thead th')].map(heading=>heading.textContent?.trim());
   expect(headings).toEqual([d.employeeName,d.employeeId,d.username,d.email,d.userTypeColumn,d.accountStatus,d.role,d.companyScope,d.lastLogin,d.actions]);
   expect(within(first).getByText('10-Nov-2026 09:30')).toBeVisible();
   const pending=[...document.querySelectorAll('[data-directory-row]')].find(row=>row.textContent?.includes('Daniel Tan')) as HTMLElement;
   expect(within(pending).getByText(d.neverLoggedIn)).toBeVisible();
   expect(within(pending).getByRole('link',{name:d.viewEditFor.replace('{name}','Daniel Tan')})).toBeVisible();
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
   // Board 0735d1b7: the row carries one View/Edit link; Reset Password, Authenticator Control and Edit moved to the
   // account page, so the row has no buttons and no expandable panel.
   expect(first.querySelectorAll('button')).toHaveLength(0);
   const view=within(first).getByRole('link',{name:d.viewEditFor.replace('{name}','Aisyah Rahman')});
   expect(view).toBeVisible();expect(view.getAttribute('href')).toBe('/admin/users/user-aisyah/account');
   const consultant=[...document.querySelectorAll('[data-directory-row]')].find(row=>row.textContent?.includes('Alexandra Christina Consultant')) as HTMLElement;
   expect(within(consultant).getByText(d.userTypeValue.external)).toBeVisible();expect(within(first).getByText(d.userTypeValue.internal)).toBeVisible();
   console.info('Users directory screenshot:',await page.screenshot({animations:'disabled',element:document.querySelector('main')!,path:`../.vitest-attachments/users-directory-${locale}-${width}.png`}));
   await page.getByRole('combobox',{name:d.groupBy}).selectOptions('role');
   expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(3);
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  });
 }
});
