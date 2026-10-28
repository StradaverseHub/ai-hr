/** The audience inventory retains permissions; the approved module taxonomy owns actual placement. */
import fs from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
import {navigationPlacement} from '../lib/navigation-workspaces';
const source=fs.readFileSync(path.resolve(__dirname,'../components/sidebar.tsx'),'utf8');
const performance=fs.readFileSync(path.resolve(__dirname,'../packs/performance/index.ts'),'utf8');
const lineFor=(href:string)=>source.split('\n').find(line=>line.includes(`href: '${href}'`));
describe('Personnel navigation retains its independent audience boundaries',()=>{
 it('keeps the employee directory public to employees and places it under People',()=>{
  expect(source.split("href: '/personnel'")).toHaveLength(2);
  expect(lineFor('/personnel')).toBeDefined();
  expect(lineFor('/personnel')).not.toMatch(/adminOnly:\s*true|managerUp:\s*true/);
  expect(navigationPlacement('/personnel')).toEqual({area:'ops',module:'people',section:'mine'});
 });
 it('keeps Personnel Management administrator-only and groups it with People HR work',()=>{
  expect(source.split("href: '/admin/personnel'")).toHaveLength(2);
  expect(lineFor('/admin/personnel')).toMatch(/adminOnly:\s*true/);
  expect(navigationPlacement('/admin/personnel')).toEqual({area:'ops',module:'people',section:'hr'});
 });
 it('keeps Approvals manager-up and Performance admin OneHR-administrator-only, independently of the workspace selection',()=>{
  expect(lineFor('/approvals')).toMatch(/managerUp:\s*true/);
  // D-P1-32 PT-X5: the former manager-up Performance row is Performance admin, gated by canAdministerOnehr alone.
  const row=performance.split('\n').find(line=>line.includes("href: '/performance'"));
  expect(row).toContain("labelKey: 'performanceAdmin'");
  expect(row).not.toMatch(/managerUp|adminOnly/);
  expect(source).toContain('c.href === PERFORMANCE_ADMIN_ROW.href ? canAdministerOnehr :');
  expect(navigationPlacement('/approvals')).toEqual({area:'shared'});
  expect(navigationPlacement('/performance')).toEqual({area:'strata',module:'performanceAdmin',section:'hr'});
 });
});
