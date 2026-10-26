import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import type { UserDirectoryRow } from '../app/admin/users/directory-model';
import '../app/globals.css';
import '../app/atelier.css';
vi.mock('../app/admin/actions',()=>({archiveUserAction:vi.fn(),assignRoleAction:vi.fn(),revokeInvitationAction:vi.fn(),revokeRoleAction:vi.fn(),setAssistantGrantAction:vi.fn()}));
const { UsersDirectory } = await import('../app/admin/users/users-directory');
const user=(key:string,name:string,change:Partial<UserDirectoryRow>={}):UserDirectoryRow=>({key,name,status:'active',personId:'person-'+key,email:key+'@example.test',appUserId:'user-'+key,workosUserId:'subject-'+key,roles:[{id:key+'-role',role:'employee',companyId:null,company:null}],invitationId:null,invitedRole:null,invitedCompanyId:null,manuallyArchived:false,hasEmployment:true,...change});
const rows=[user('aisyah','Aisyah Rahman',{roles:[{id:'aisyah-hr',role:'hr_admin',companyId:'acme',company:'Acme Sdn Bhd'},{id:'aisyah-employee',role:'employee',companyId:null,company:null}]}),user('arjun','Arjun Kumar'),user('consultant','Alexandra Christina Consultant',{hasEmployment:false,email:'alexandra.christina.consultant@external-company.example.test'}),user('pending','Daniel Tan',{status:'pending',appUserId:null,roles:[]})];
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
describe('Users directory desktop/mobile experience',()=>{
 for(const width of [390,1280])for(const [locale,messages]of [['en',en],['ta',ta]]as const){
  it(`${locale} at ${width}px shows readable users and working grouped access controls`,async()=>{
   await page.viewport(width,1100);document.documentElement.setAttribute('data-ui-theme','atelier');
   render(<NextIntlClientProvider locale={locale} messages={messages}><main className="mx-auto max-w-5xl p-4"><UsersDirectory rows={rows} groupAdmin includeArchived={false} companies={[{id:'acme',name:'Acme Sdn Bhd'}]} roleOptions={['employee','hr_admin']} assistantGrantedIds={['user-aisyah']}/></main></NextIntlClientProvider>);
   const d=messages.admin.users.directory;
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   const email=screen.getByText('alexandra.christina.consultant@external-company.example.test');
   expect(email.scrollWidth).toBeLessThanOrEqual(email.clientWidth+1);
   const first=document.querySelector('[data-directory-row]')!;
   await page.getByRole('button',{name:d.manage}).first().click();
   expect(screen.getByRole('region',{name:d.accessFor.replace('{name}','Aisyah Rahman')})).toBeTruthy();
   for(const control of first.querySelectorAll('button'))expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
   await page.getByRole('combobox',{name:d.groupBy}).selectOptions('role');
   expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(3);
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   console.info('Users directory screenshot:',await page.screenshot({path:`../.vitest-attachments/users-directory-${locale}-${width}.png`}));
  });
 }
});
