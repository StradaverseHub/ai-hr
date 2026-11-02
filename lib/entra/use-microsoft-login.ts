'use client';
import { useEffect, useState } from 'react';
import { watchMicrosoftLogin } from './login-availability';
/** Keep React bound to this platform's installation; the shared watcher has no React dependency. */
export function useMicrosoftLogin(organization:string,origin:string|null='',fetcher:typeof fetch=fetch,refresh=0) {
  const code=organization.trim().toLowerCase(),key=JSON.stringify([origin,code,refresh]);
  const [result,setResult]=useState({key,enabled:false});
  if(result.key!==key)setResult({key,enabled:false});
  useEffect(()=>watchMicrosoftLogin(code,origin,fetcher,enabled=>setResult({key,enabled})),[code,origin,fetcher,key]);
  return result.key===key&&result.enabled;
}
