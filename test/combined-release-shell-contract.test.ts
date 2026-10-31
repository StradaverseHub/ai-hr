import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import geometry from './fixtures/combined-release-shell-geometry.json';

// The browser fixture uses production components inside the server layout's exact geometry.
// This guard prevents the synthetic session shell from silently drifting from that layout.
describe('combined release rendered-shell source boundary',()=>{
 it('pins every copied shell class to the actual server layout',()=>{
  const layout=readFileSync('app/(app)/layout.tsx','utf8');
  const shellAt=layout.indexOf('<div data-app-shell ');
  expect(shellAt).toBeGreaterThan(0);
  const bodyAt=layout.lastIndexOf('<body ',shellAt);
  expect(bodyAt).toBeGreaterThan(0);
  // V9 owns a separate earlier body. Pin the ordinary shell that this fixture actually renders.
  const source=layout.slice(bodyAt);
  for(const [key,pattern] of Object.entries({body:/<body className="([^"]+)"/,shell:/<div data-app-shell className="([^"]+)"/,content:/<div data-app-content className="([^"]+)"/,header:/<header className="([^"]+)" data-app-header>/,main:/<main className="([^"]+)">/})){
   expect(source.match(pattern)?.[1],key).toBe(geometry[key as keyof typeof geometry]);
  }
 });
 it('keeps the actual audit and personnel pagers above their rows',()=>{
  const audit=readFileSync('app/(app)/admin/audit/page.tsx','utf8');
  expect(audit.indexOf('<Pager basePath="/admin/audit"')).toBeGreaterThan(0);
  expect(audit.indexOf('<Pager basePath="/admin/audit"')).toBeLessThan(audit.indexOf('<AuditTable rows='));
  const personnel=readFileSync('app/(app)/admin/personnel/page.tsx','utf8');
  expect(personnel.indexOf('{pager}')).toBeGreaterThan(0);
  expect(personnel.indexOf('{pager}')).toBeLessThan(personnel.indexOf('<table'));
 });
 it('retains real server authorization behind the displayed destinations',()=>{
  expect(readFileSync('app/(app)/admin/audit/page.tsx','utf8')).toContain('await requireAdmin()');
  expect(readFileSync('app/(app)/admin/personnel/page.tsx','utf8')).toContain('await requireWorkforceAccess()');
 });
});
