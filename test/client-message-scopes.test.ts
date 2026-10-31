import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
import {computeClientMessageScopes} from '../scripts/client-message-scopes';
it('follows client imports and namespace constants, ignores type-only and server-action graphs, and fails closed on unscoped usage',()=>{
 const root=mkdtempSync(join(tmpdir(),'aihr-message-scopes-'));
 const put=(path:string,value:string)=>{mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),value);};
 try{
  put('app/layout.tsx',"import '../components/shell'; import type {X} from '../components/private';");
  put('components/shell.tsx',"'use client'; import {useTranslations as translate} from 'next-intl';import {NAMESPACE} from '../lib/namespace';import '../app/action';translate(NAMESPACE);");
  put('lib/namespace.ts',"export const NAMESPACE='common' as const;");
  put('components/private.tsx',"'use client';useTranslations();");
  put('app/action.ts',"'use server';import '../components/private';");
  put('app/claims/page.tsx',"import './form';");put('app/claims/form.tsx',"'use client';useTranslations('claims');");
  put('app/unknown/page.tsx',"'use client';useTranslations();");
  const result=computeClientMessageScopes(root);
  expect(result.shared).toEqual({prefixes:['common'],unknown:[]});
  expect(result.segments.claims).toEqual({prefixes:['claims'],unknown:[]});
  expect(result.segments.unknown.prefixes).toBeNull();
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('inventories the application catalog requirements without executing application code',()=>{
 const root=fileURLToPath(new URL('..',import.meta.url)),result=computeClientMessageScopes(root);
 expect(result.version).toBe(1);expect(result.segments.claims).toBeDefined();
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'client-message-scopes.json'),JSON.stringify(result,null,2));
},60000);

it('keeps the checked-in scope contract current for all shell and route client imports',()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));
 const expected=JSON.parse(readFileSync(join(root,'i18n/client-message-scopes.json'),'utf8'));
 expect(computeClientMessageScopes(root)).toEqual(expected);
},60000);
