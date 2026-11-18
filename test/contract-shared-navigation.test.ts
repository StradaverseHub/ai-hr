import {expect,it} from 'vitest';
import {resolveShellNavigation} from '../lib/navigation/shell-resolver';
import {placeNavigation} from '../lib/navigation-workspaces';
it('places the eligible pre-case tracker in its own Ops module and separates Automation from Contract settings',()=>{
 const resolve=(contractStaffAccess:{page:boolean;configure:boolean;intake:boolean;automation:boolean;postings:boolean})=>resolveShellNavigation({isAdmin:false,enabledModules:[],contractStaffAccess});
 const viewer=resolve({page:true,configure:false,intake:false,automation:false,postings:false}),tracker=placeNavigation(viewer.destinations).placed.find(row=>row.destination.href==='/lifecycle/contracts');
 expect(tracker?.placement).toEqual({area:'ops',module:'contracts',section:'hr'});expect(viewer.destinations.some(row=>row.href.startsWith('/automation/'))).toBe(false);
 const builder=resolve({page:false,configure:false,intake:false,automation:true,postings:false});expect(builder.destinations.some(row=>row.href==='/automation/workflows')).toBe(true);expect(builder.destinations.some(row=>row.href.startsWith('/lifecycle/contracts'))).toBe(false);
 const settings=resolve({page:true,configure:true,intake:false,automation:false,postings:false});expect(settings.destinations.some(row=>row.href==='/lifecycle/contracts/settings')).toBe(true);expect(settings.destinations.some(row=>row.href.startsWith('/automation/'))).toBe(false);
});

it('offers the native posting destination only from its own scope, including a group actor without Case View',()=>{
 const base={isAdmin:false,enabledModules:[],contractStaffAccess:{page:false,configure:false,intake:false,automation:false,postings:true}};
 const authorized=resolveShellNavigation(base),destinations=authorized.destinations.map(row=>row.href);
 expect(destinations).toContain('/lifecycle/contracts/postings');expect(destinations).not.toContain('/lifecycle/contracts');expect(destinations).not.toContain('/lifecycle/contracts/settings');
 expect(placeNavigation(authorized.destinations).placed.find(row=>row.destination.href==='/lifecycle/contracts/postings')?.placement).toEqual({area:'ops',module:'contracts',section:'hr'});
 const viewer=resolveShellNavigation({...base,contractStaffAccess:{...base.contractStaffAccess,page:true,postings:false}}).destinations.map(row=>row.href);
 expect(viewer).toContain('/lifecycle/contracts');expect(viewer).not.toContain('/lifecycle/contracts/postings');
});
