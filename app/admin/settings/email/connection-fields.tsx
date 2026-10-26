'use client';
import {useState} from 'react';
import {useTranslations} from 'next-intl';
import {Field,inputCls} from '@/components/ui';
import type {EmailConfig} from '@/lib/identity/email-model';

/** Public configuration only; saved credentials never cross the server/client boundary. */
export function SavedEmailConnectionFields({config,allowMicrosoft365,hasSecret}:{config:EmailConfig;allowMicrosoft365:boolean;hasSecret:boolean}) {
 const t=useTranslations('identityEmail');
 const [method,setMethod]=useState(config.authentication??String(config.auth));
 const [host,setHost]=useState(config.host),[port,setPort]=useState(config.port),[security,setSecurity]=useState(config.security);
 const [user,setUser]=useState(config.user),[from,setFrom]=useState(config.from);
 const [tenantId,setTenantId]=useState(config.oauth2?.tenantId??''),[clientId,setClientId]=useState(config.oauth2?.clientId??'');
 const microsoft=method==='microsoft365';
 const keepSecret=hasSecret&&method===(config.authentication??String(config.auth))&&host===config.host&&user===config.user
  &&(!microsoft||(tenantId===config.oauth2?.tenantId&&clientId===config.oauth2?.clientId));
 return <>
  <Field label={t('authentication')}><select name="auth" className={inputCls} value={method} onChange={event=>{
   const next=event.target.value;setMethod(next);
   if(next==='microsoft365'){setHost('smtp.office365.com');setPort(587);setSecurity('starttls');if(!user)setUser(from);}
  }}><option value="true">{t('passwordAuthentication')}</option><option value="false">{t('noAuthentication')}</option>
   {allowMicrosoft365&&<option value="microsoft365">{t('microsoft365Authentication')}</option>}
  </select></Field>
  <Field label={t('security')}><select name="security" className={inputCls} value={security} onChange={event=>{
   const next=event.target.value as EmailConfig['security'];setSecurity(next);if(port===465||port===587)setPort(next==='tls'?465:587);
  }}><option value="tls" disabled={microsoft}>{t('tlsSecurity')}</option><option value="starttls">{t('starttlsSecurity')}</option></select></Field>
  <Field label={t('host')}><input name="host" placeholder="smtp.example.com" value={host} onChange={event=>setHost(event.target.value)} readOnly={microsoft} required maxLength={253} className={inputCls} autoComplete="off"/></Field>
  <Field label={t('port')}><input name="port" type="number" min={1} max={65535} required value={port} readOnly={microsoft} onChange={event=>setPort(Number(event.target.value))} className={inputCls}/></Field>
  <Field label={t('from')}><input name="from" placeholder="hr@example.com" type="email" required value={from} onChange={event=>setFrom(event.target.value)} maxLength={320} className={inputCls}/></Field>
  <Field label={t('fromName')}><input name="fromName" defaultValue={config.fromName} maxLength={160} className={inputCls}/></Field>
  <Field label={t('username')}><input name="user" autoComplete="off" value={user} onChange={event=>setUser(event.target.value)} required={method!=='false'} type={microsoft?'email':'text'} maxLength={320} className={inputCls}/></Field>
  <Field label={t(microsoft?'clientSecret':'password')}><input key={method} name="password" type="password" autoComplete="new-password" required={method!=='false'&&!keepSecret} disabled={method==='false'} maxLength={4096} className={inputCls}/></Field>
  {microsoft&&<>
   <Field label={t('tenantId')}><input name="tenantId" value={tenantId} onChange={event=>setTenantId(event.target.value)} required autoComplete="off" maxLength={36} className={inputCls}/></Field>
   <Field label={t('clientId')}><input name="clientId" value={clientId} onChange={event=>setClientId(event.target.value)} required autoComplete="off" maxLength={36} className={inputCls}/></Field>
   <p className="max-w-prose text-sm text-muted-foreground sm:col-span-2">{t('microsoft365Help')}</p>
  </>}
  <Field label={t('replyTo')} className="sm:col-span-2"><input name="replyTo" type="email" defaultValue={config.replyTo} maxLength={320} className={inputCls}/></Field>
  {method!=='false'&&<p className="text-sm text-muted-foreground sm:col-span-2">{t(microsoft?(keepSecret?'clientSecretKept':'clientSecretNeeded'):(keepSecret?'passwordKept':'passwordNeeded'))}</p>}
 </>;
}
