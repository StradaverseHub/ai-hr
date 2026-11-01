import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import geometry from './fixtures/combined-release-shell-geometry.json';
import controls from './fixtures/classic-header-controls.json';

// The server layout needs a real session. Its rendered browser fixture therefore uses
// the exact production geometry and real controls, with this independent drift guard.
describe('Classic header browser fixture source boundary',()=>{
 it('measures the actual server header and each of its three control clusters',()=>{
  const layout=readFileSync('app/layout.tsx','utf8');
  const start=layout.indexOf('<header className="grid h-16');
  const end=layout.indexOf('</header>',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
  const header=layout.slice(start,end);
  expect(header).toContain(`className="${geometry.header}"`);
  expect(Object.keys(controls)).toHaveLength(5);
  for(const cls of Object.values(controls)){
   expect(cls.length).toBeGreaterThan(20);
   expect(header).toContain(`className="${cls}"`);
  }
  expect([...header.matchAll(/<(NotificationCenter|LanguageSwitcher|ThemeToggle|UserMenu)\b/g)].map(match=>match[1])).toEqual(['NotificationCenter','LanguageSwitcher','ThemeToggle','UserMenu']);
 });
 it('loads the same global workspace CSS that styles the live header',()=>{
  expect(readFileSync('app/layout.tsx','utf8')).toContain("import './onboarding-workspace.css'");
  expect(readFileSync('test/classic-header-overlap.browser.test.tsx','utf8')).toContain("import '../app/onboarding-workspace.css'");
 });
});
