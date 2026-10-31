/** Real page/components and compiled CSS; synthetic server projections, no SMTP or live accounts. */
import React,{isValidElement,cloneElement,type ReactNode} from 'react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {page} from 'vitest/browser';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider,createTranslator} from 'next-intl';
import en from '../messages/en.json';
import ta from '../messages/ta.json';
import type {EmailSettingsView} from '../lib/identity/email-model';
import '../app/globals.css';
import '../app/atelier.css';

const state=vi.hoisted(()=>({locale:'en' as 'en'|'ta',view:null as EmailSettingsView|null}));
vi.mock('next-intl/server',()=>({getLocale:async()=>state.locale,getTranslations:async(namespace:'identityEmail'|'accountEmail'|'internalAuth')=>createTranslator({locale:state.locale,messages:state.locale==='en'?en:ta,namespace})}));
vi.mock('../lib/scope',()=>({scopedSession:async()=>({s:{userId:'fixture-admin',tenantId:'fixture-tenant'}})}));
vi.mock('../lib/authz',()=>({isAdmin:()=>true}));
vi.mock('../lib/demo-mode',()=>({demoSwitcherEnabled:()=>false}));
vi.mock('../lib/internal-auth/config',()=>({internalSelected:()=>true}));
vi.mock('../localization/registry',()=>({countryPacks:()=>[{displayClock:{timeZone:'Asia/Kuala_Lumpur',label:'MYT'}}]}));
vi.mock('../lib/identity/email-settings',()=>({canConfigureIdentityEmail:async()=>true,requireIdentityEmailAdmin:async()=>({session:{},actor:{}}),readIdentityEmailSettings:async()=>state.view}));
vi.mock('../lib/identity/email-model',()=>({defaultEmailConfig:{host:'',port:465,security:'tls',from:'',fromName:'AI HR',replyTo:'',auth:true,user:''},emailFailureCodes:[],EmailSettingsError:class extends Error{code='unavailable';}}));
vi.mock('../lib/internal-auth/account-email-view',()=>({withInternalRecoveryLabels:async(_session:unknown,_actor:unknown,items:unknown)=>items}));
vi.mock('../core/account-email',()=>({readAccountEmailHistory:async()=>({items:[{id:'delivery-fixture',kind:'invitation',email:'alexandra.christina.consultant@synthetic-company.example.test',status:'sent',attempts:1,error:null,createdAt:new Date('2026-10-27T01:00:00Z'),canRetry:true}],hasMore:true,nextCursor:'synthetic-next-page'})}));
vi.mock('../core/account-email-retention',()=>({readAccountEmailRetention:async()=>({days:null,revision:0,lastRunAt:null,lastDeleted:0})}));
vi.mock('../app/(app)/admin/settings/email/actions',()=>({saveEmailDraft:vi.fn(),testEmailDraft:vi.fn(),activateEmailDraft:vi.fn(),saveEmailRetention:vi.fn()}));
vi.mock('../app/(app)/admin/settings/email/demo-actions',()=>({testDemoSmtpConnection:vi.fn()}));
vi.mock('../app/(app)/admin/settings/notifications/actions',()=>({retryAccountEmailAction:vi.fn()}));
const {default:EmailPage}=await import('../app/(app)/admin/settings/email/page');
const {AccountEmailDeliveries}=await import('../components/account-email-deliveries');

const relay={host:'smtp.office365.com',port:587,security:'starttls' as const,from:'no-reply@synthetic-company.example.test',fromName:'Synthetic OneHR',replyTo:'',auth:true,user:'service-mailbox@synthetic-company.example.test'};
function view(detail:boolean):EmailSettingsView{const saved={...relay,fromName:'Synthetic OneHR (saved update)'};return {active:{...relay,hasPassword:true},revision:'r'.repeat(43),draft:detail?{id:'saved-version',config:saved,hasPassword:true,testedAt:'2026-10-27T01:00:00Z'}:null,testRecipient:'operator@example.test',connections:[{id:'primary',name:'Microsoft 365 · Synthetic staging connection',config:saved,hasPassword:true,active:true,hasUnappliedChanges:true,testedAt:'2026-10-27T01:00:00Z'},{id:'backup',name:'Synthetic backup connection',config:{...relay,host:'smtp.backup.example.test'},hasPassword:true,active:false,hasUnappliedChanges:false,testedAt:null}],...(detail?{selectedConnectionId:'primary',selectedConnectionName:'Microsoft 365 · Synthetic staging connection'}:{})};}
/** Resolve the actual async server child before mounting its client/presentational descendants. */
async function resolveServer(node:ReactNode):Promise<ReactNode>{
 if(Array.isArray(node))return Promise.all(node.map(resolveServer));
 if(!isValidElement<{children?:ReactNode}>(node))return node;
 if(node.type===AccountEmailDeliveries)return resolveServer(await AccountEmailDeliveries(node.props as unknown as Parameters<typeof AccountEmailDeliveries>[0]));
 return node.props.children===undefined?node:cloneElement(node,{},await resolveServer(node.props.children));
}
afterEach(()=>{cleanup();document.documentElement.removeAttribute('data-ui-theme');});
describe('Email delivery page list/detail at desktop and mobile sizes',()=>{
 for(const width of [390,1280])for(const locale of ['en','ta'] as const)for(const detail of [false,true]){
  it(`${locale} ${detail?'detail':'list'} at ${width}px keeps the page contained and exposes the saved state`,async()=>{
   await page.viewport(width,1100);state.locale=locale;state.view=view(detail);document.documentElement.setAttribute('data-ui-theme','atelier');document.body.style.margin='0';
   const content=await resolveServer(await EmailPage({searchParams:Promise.resolve(detail?{connection:'primary'}:{})}));
   render(<NextIntlClientProvider locale={locale} messages={locale==='en'?en:ta}><main className="min-w-0 p-4">{content}</main></NextIntlClientProvider>);
   const messages=locale==='en'?en:ta;
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   expect(document.querySelector('[data-active-connection-name]')).toHaveTextContent('Microsoft 365 · Synthetic staging connection');
   expect(document.querySelector('[data-email-recipient]')!.getBoundingClientRect().width).toBeGreaterThanOrEqual(288);
   expect(screen.getByRole('heading',{name:messages.identityEmail.title})).toBeVisible();
   expect(screen.getByRole('heading',{name:messages.accountEmail.retentionTitle})).toBeVisible();
   expect(screen.getByLabelText(messages.accountEmail.retentionPeriod)).toHaveValue('never');
   expect(screen.getByText('MYT · Asia/Kuala_Lumpur')).toBeVisible();
   if(detail){
    expect(screen.getByLabelText(messages.identityEmail.connectionName)).toHaveValue('Microsoft 365 · Synthetic staging connection');
    expect(screen.getByLabelText(messages.identityEmail.password)).toHaveValue('');
    expect(screen.getByRole('button',{name:messages.identityEmail.sendTest})).toBeVisible();
    expect(screen.getByRole('checkbox',{name:messages.identityEmail.received})).not.toBeChecked();
   }else{
    expect(screen.getByRole('link',{name:messages.identityEmail.newConnection})).toBeVisible();
    expect(screen.getAllByText(messages.identityEmail.connectionActive).some(node=>node.getClientRects().length>0)).toBe(true);
    expect(screen.getAllByText(messages.identityEmail.connectionSaved).some(node=>node.getClientRects().length>0)).toBe(true);
    if(width<1024){
     const row=screen.getByRole('link',{name:'Microsoft 365 · Synthetic staging connection'}).closest('tr')!;
     expect(row.querySelector('[data-mobile-connection-state]')).toBeVisible();
     const pending=row.querySelector('[data-mobile-pending-changes]')!;
     expect(pending).toBeVisible();expect(pending).toHaveTextContent(messages.identityEmail.changesPending);
     expect(pending.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    }
   }
   await page.getByText(messages.accountEmail.viewEmail,{exact:true}).click();
   expect(screen.getByText(messages.accountEmail.previewHelp)).toBeVisible();
   await page.getByText(messages.accountEmail.resend,{exact:true}).first().click();
   expect(screen.getByRole('checkbox',{name:messages.accountEmail.invitationAck})).not.toBeChecked();
   if(!detail){
    await page.getByLabelText(messages.accountEmail.retentionPeriod).selectOptions('days');
    expect(screen.getByRole('checkbox',{name:messages.accountEmail.retentionAcknowledge})).not.toBeChecked();
   }
   expect(document.querySelector('a[href*="/invite/"],input[name="token"]')).toBeNull();
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   // Vitest captures an element inside an iframe, not a top-level document. A body screenshot
   // taller than that iframe contains blank unpainted regions even when assertions pass.
   const main=document.querySelector('main')!;
   await page.viewport(width,Math.ceil(main.scrollHeight+32));window.scrollTo(0,0);await document.fonts.ready;
   await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
   expect(main.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
   expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
   // Vitest 4.1.8 also scales its *outer harness wrapper* to fit the runner UI. Remove that
   // harness-only transform during capture; never change application styles or upscale a PNG.
   const wrapper=window.frameElement?.parentElement;
   expect(wrapper).toBeTruthy();
   const originalStyle=wrapper!.getAttribute('style'),originalScale=wrapper!.getAttribute('data-scale');
   wrapper!.style.setProperty('transform','none','important');wrapper!.setAttribute('data-scale','1');
   try{
    const screenshot=await page.screenshot({animations:'disabled',element:main,scale:'css',base64:true,
     style:'#vitest-tester [data-scale], #tester-ui [data-scale] { transform: none !important; }',
     path:`../.vitest-attachments/email-delivery-${locale}-${detail?'detail':'list'}-${width}.png`});
    const bytes=Uint8Array.from(atob(screenshot.base64),char=>char.charCodeAt(0)),header=new DataView(bytes.buffer);
    expect(header.getUint32(16),'PNG must retain the declared CSS viewport width').toBe(width);
    expect(header.getUint32(20),'PNG must include the full painted page').toBeGreaterThanOrEqual(Math.floor(main.getBoundingClientRect().height)-1);
    console.info('Synthetic email delivery page screenshot:',{path:screenshot.path,width:header.getUint32(16),height:header.getUint32(20)});
   }finally{
    if(originalStyle===null)wrapper!.removeAttribute('style');else wrapper!.setAttribute('style',originalStyle);
    if(originalScale===null)wrapper!.removeAttribute('data-scale');else wrapper!.setAttribute('data-scale',originalScale);
   }
  });
 }
});
