import {describe,it,expect} from 'vitest';
import {SECURITY_CENTER,SECURITY_PAGES,SECURITY_MENU_PAGES,securityDestinationAllowed,legacySecurityDestination} from '../lib/security-center-navigation';
import {GROUPS,isCollapsible} from '../lib/navigation/shell-inventory';
import {navigationPlacement,navigationRouteOwner} from '../lib/navigation-workspaces';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import vi from '../messages/vi.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
const person='11111111-2222-3333-4444-555555555555';
describe('closed Security Center navigation',()=>{
 it('uses the explicit password-policy availability independently of other administration links',()=>{
  expect(securityDestinationAllowed('/admin/security-center/password-policy',{admin:true,configure:true,provision:true,passwordPolicy:false})).toBe(false);
  expect(securityDestinationAllowed('/admin/security-center/password-policy',{admin:true,configure:true,provision:true,passwordPolicy:true})).toBe(true);
 });
 it.each([
  [{admin:true,configure:true,provision:true},6],
  [{admin:true,configure:false,provision:false},3],
  [{admin:false,configure:true,provision:false},2],
  [{admin:false,configure:false,provision:false},0],
 ] as const)('publishes only permitted destinations %j', (access,count)=>{
  expect([SECURITY_CENTER,...SECURITY_PAGES.map(p=>p.href)].filter(href=>securityDestinationAllowed(href,access))).toHaveLength(count);
  expect(securityDestinationAllowed('https://foreign.test',access)).toBe(false);
 });
 it('preserves fragment intent and selected person, dropping all unrecognized input',()=>{
  const query=new URLSearchParams({activate:person,returnTo:'https://foreign.test',manualSuccess:'created'});
  expect(legacySecurityDestination('#invite-user',query)).toBe(`/admin/users/invite?activate=${person}`);
  expect(legacySecurityDestination('#manual-account-setup',query)).toBe(`/admin/users/create?activate=${person}`);
  expect(legacySecurityDestination('#anything',query)).toBeNull();
  expect(legacySecurityDestination('#invite-user',new URLSearchParams({activate:'javascript:alert(1)'}))).toBe('/admin/users/invite');
 });
 it('lists every Security Center page exactly once in the menu, in the reporter order, without the overview (board 8fa0a31d)',()=>{
  expect(SECURITY_MENU_PAGES.map(page=>page.href)).toEqual(['/admin/users/access','/admin/security-center/password-policy','/admin/users/function-access','/admin/users','/admin/users/create','/admin/users/invite']);
  expect([...SECURITY_MENU_PAGES].sort((a,b)=>a.key.localeCompare(b.key))).toEqual([...SECURITY_PAGES].sort((a,b)=>a.key.localeCompare(b.key)));
  const rows=GROUPS.flatMap(group=>group.items.flatMap(row=>isCollapsible(row)?row.children:[row])).map(row=>row.href);
  expect(rows).not.toContain(SECURITY_CENTER);
  expect(rows.filter(href=>SECURITY_PAGES.some(page=>page.href===href))).toEqual(SECURITY_MENU_PAGES.map(page=>page.href));
  // The overview's own cards keep their established order.
  expect(SECURITY_PAGES.map(page=>page.key)).toEqual(['permissions','functions','create','invite','users','passwordPolicy']);
 });
 it('places every page in System Configuration and chooses only the specific owner',()=>{
  const rows=[{href:SECURITY_CENTER,exactHref:true},...SECURITY_PAGES.map(p=>({...p,exactHref:true}))];
  for(const row of rows){expect(navigationPlacement(row.href)).toEqual({area:'system'});expect(navigationRouteOwner(row.href,'',rows)?.destination.href).toBe(row.href);}
 });
 it('provides all overview, navigation and scope-note copy in all six locales',()=>{
  const keys=(object:object,prefix=''):string[]=>Object.entries(object).flatMap(([key,value])=>typeof value==='object'?keys(value,`${prefix}${key}.`):[`${prefix}${key}`]);
  for(const messages of [en,ms,zh,vi,ta,th]){
   expect(keys(messages.securityCenter).sort()).toEqual(keys(en.securityCenter).sort());
   for(const page of SECURITY_PAGES)expect(messages.nav[page.navKey].trim()).not.toBe('');
   for(const key of ['securityCenter','createLogin','inviteUser'] as const)expect(messages.admin.users.scope[key].trim()).not.toBe('');
  }
 });
});
