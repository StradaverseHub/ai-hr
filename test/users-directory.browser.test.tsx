import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import type { UserDirectoryRow } from '../app/(app)/admin/users/directory-model';
import '../app/globals.css';
import '../app/atelier.css';
vi.mock('../app/(app)/admin/actions',()=>({archiveUserAction:vi.fn(),assignRoleAction:vi.fn(),revokeInvitationAction:vi.fn(),revokeRoleAction:vi.fn(),setAssistantGrantAction:vi.fn()}));
const { UsersDirectory } = await import('../app/(app)/admin/users/users-directory');
const user=(key:string,name:string,change:Partial<UserDirectoryRow>={}):UserDirectoryRow=>({key,name,status:'active',personId:'person-'+key,email:key+'@example.test',appUserId:'user-'+key,loginSuffix:null,roles:[{id:key+'-role',role:'employee',companyId:null,company:null}],invitationId:null,invitedRole:null,invitedCompanyId:null,manuallyArchived:false,hasEmployment:true,...change});
const rows=[user('aisyah','Aisyah Rahman',{roles:[{id:'aisyah-hr',role:'hr_admin',companyId:'acme',company:'Acme Sdn Bhd'},{id:'aisyah-employee',role:'employee',companyId:null,company:null}]}),user('arjun','Arjun Kumar'),user('consultant','Alexandra Christina Consultant',{hasEmployment:false,email:'alexandra.christina.consultant@external-company.example.test'}),user('pending','Daniel Tan',{status:'pending',appUserId:null,roles:[]})];
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
describe('Users directory desktop/mobile experience',()=>{
 for(const width of [390,1280])for(const [locale,messages]of [['en',en],['ta',ta]]as const){
  it(`${locale} at ${width}px shows readable users and working grouped access controls`,async()=>{
   await page.viewport(width,1100);document.documentElement.setAttribute('data-ui-theme','atelier');
   render(<NextIntlClientProvider locale={locale} messages={messages}><main className="mx-auto max-w-5xl p-4"><UsersDirectory rows={rows} groupAdmin includeArchived={false} companies={[{id:'acme',name:'Acme Sdn Bhd'}]} roleOptions={['employee','hr_admin']} assistantGrantedIds={['user-aisyah']}/><table aria-hidden="true" className="pointer-events-none invisible absolute w-72 text-sm"><tbody><tr data-standard-row><td className="px-3 py-2">Reference user</td><td><button className="underline">Edit</button></td></tr></tbody></table></main></NextIntlClientProvider>);
   const d=messages.admin.users.directory;
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   const email=screen.getByText('alexandra.christina.consultant@external-company.example.test');
   expect(email.scrollWidth).toBeLessThanOrEqual(email.clientWidth+1);
   const first=document.querySelector('[data-directory-row]')!;
   const accessCell=first.querySelectorAll('td')[1] as HTMLElement;
   const lastGrant=accessCell.querySelector('li:last-child')!;
   expect(lastGrant.getBoundingClientRect().bottom).toBeLessThanOrEqual(accessCell.getBoundingClientRect().bottom);
   if(width<768){
    const assistantCell=first.querySelectorAll('td')[2] as HTMLElement;
    expect(accessCell.getBoundingClientRect().bottom).toBeLessThanOrEqual(assistantCell.getBoundingClientRect().top);
   }
   for(const control of first.querySelectorAll('button'))expect(control.getBoundingClientRect().height).toBeGreaterThanOrEqual(width<768?44:24);
   if(width>=768){
    const standard=document.querySelector('[data-standard-row]')!.getBoundingClientRect();
    const ordinary=[...document.querySelectorAll('[data-directory-row]')].find(row=>row.textContent?.includes('Arjun Kumar'))!;
    expect(Math.abs(ordinary.getBoundingClientRect().height-standard.height)).toBeLessThanOrEqual(1);
    console.info('Desktop table density:',{ordinary:ordinary.getBoundingClientRect().height,standard:standard.height,multiRole:first.getBoundingClientRect().height});
    expect(first.getBoundingClientRect().height).toBeLessThanOrEqual(standard.height+20);
   }
   await page.getByRole('button',{name:d.manage}).first().click();
   const panel=screen.getByRole('region',{name:d.accessFor.replace('{name}','Aisyah Rahman')});
   expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(panel.closest('td')!.getBoundingClientRect().bottom);
   console.info('User access screenshot:',await page.screenshot({animations:'disabled',element:document.querySelector('main')!,path:`../.vitest-attachments/users-access-${locale}-${width}.png`}));
   await page.getByRole('combobox',{name:d.groupBy}).selectOptions('role');
   expect(document.querySelectorAll('th[scope="rowgroup"]')).toHaveLength(3);
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   console.info('Users directory screenshot:',await page.screenshot({animations:'disabled',element:document.querySelector('main')!,path:`../.vitest-attachments/users-directory-${locale}-${width}.png`}));
  });
 }
});
