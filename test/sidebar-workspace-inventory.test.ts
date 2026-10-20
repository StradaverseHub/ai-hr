import {describe,it,expect,vi} from 'vitest';
vi.mock('../lib/session',()=>({getSession:vi.fn()}));
vi.mock('../core/entitlements',()=>({isModuleEnabled:vi.fn()}));
import {SIDEBAR_AUDIENCE_INVENTORY} from '../components/sidebar';
import {placeNavigation} from '../lib/navigation-workspaces';

describe('module placement covers the actual prior sidebar inventory',()=>{
 it('keeps every published href, original row object, and original visibility metadata',()=>{
  const rows=SIDEBAR_AUDIENCE_INVENTORY.flatMap(group=>group.items.flatMap(row=>
   'children' in row?row.children:[row],
  ));
  expect(rows.length).toBeGreaterThan(50);
  const before=rows.map(row=>({row,href:row.href,admin:row.adminOnly,manager:row.managerUp,email:row.identityEmailOnly}));
  const result=placeNavigation(rows);
  expect(result.unplaced.map(row=>row.href)).toEqual([]);
  expect(new Set(result.placed.map(row=>row.destination.href))).toEqual(new Set(rows.map(row=>row.href)));
  expect(result.placed).toHaveLength(new Set(rows.map(row=>row.href)).size);
  for(const entry of before){
   expect(entry.row.href).toBe(entry.href);expect(entry.row.adminOnly).toBe(entry.admin);
   expect(entry.row.managerUp).toBe(entry.manager);expect(entry.row.identityEmailOnly).toBe(entry.email);
  }
  for(const placed of result.placed)expect(rows).toContain(placed.destination);
 });
});
