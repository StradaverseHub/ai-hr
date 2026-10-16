import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {ASSISTANT_ROUTES,assistantWorkflowHref} from '../lib/assistant-routes';
import {ASSISTANT_HANDOFFS,assistantConfirmedPayload} from '../lib/assistant-conversation-model';
const root=resolve(__dirname,'..');
describe('reviewed local route and language contracts',()=>{
 it('links only exact existing local pages with closed fixed query metadata',()=>{
  for(const route of ASSISTANT_HANDOFFS){const href=assistantWorkflowHref(route),url=new URL(href,'https://fixture.invalid');expect(url.origin).toBe('https://fixture.invalid');expect(href).not.toMatch(/[\r\n#]/);expect(existsSync(resolve(root,'app',url.pathname.slice(1),'page.tsx')),route).toBe(true);
   if(url.search){expect(url.pathname).toBe('/me');expect([...url.searchParams.keys()]).toEqual(['tab']);expect(['payroll','documents']).toContain(url.searchParams.get('tab'));}
   if(ASSISTANT_ROUTES[route].admin)expect(readFileSync(resolve(root,'app',url.pathname.slice(1),'page.tsx'),'utf8')).toMatch(/requireAdmin|scopedAdmin|requirePayrollAccess/);
  }
 });
 it('has matching visible vocabulary in all six locales, including every capability and reviewed route',()=>{
  const expected=JSON.parse(readFileSync(resolve(root,'messages/en.json'),'utf8')).assistantConversation;
  for(const locale of ['en','ms','zh','ta','th','vi']){const copy=JSON.parse(readFileSync(resolve(root,`messages/${locale}.json`),'utf8')).assistantConversation;expect(Object.keys(copy).sort()).toEqual(Object.keys(expected).sort());expect(Object.keys(copy.routes).sort()).toEqual([...ASSISTANT_HANDOFFS].sort());for(const [key,value]of Object.entries(copy))if(key!=='routes')expect(typeof value==='string'&&value.length>0,`${locale}.${key}`).toBe(true);}
 });
 it('rejects case-variant duplicate UUID subjects and any caller-supplied action flags',()=>{
  const id='abcdefab-1234-4123-8123-abcdefabcdef';expect(assistantConfirmedPayload.safeParse({typeId:'close_fixed_upstream',verdictIds:[id,id.toUpperCase()]}).success).toBe(false);expect(assistantConfirmedPayload.safeParse({typeId:'close_fixed_upstream',verdictIds:[id],confirmed:true}).success).toBe(false);
 });
});
