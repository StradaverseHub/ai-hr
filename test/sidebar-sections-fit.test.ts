/** Source invariants only. Actual viewport measurement remains required before release. */
import fs from 'node:fs';
import path from 'node:path';
import {describe,it,expect} from 'vitest';
const source=fs.readFileSync(path.resolve(__dirname,'../components/sidebar.tsx'),'utf8');
describe('workspace navigation keeps controls reachable',()=>{
 it('limits workspace rows to the selected authorized workspace without removing shared destinations',()=>{
  expect(source).toContain('module.workspace === selectedWorkspace');
  expect(source).toContain("row.placement.area==='shared'");
  expect(source).toContain("row.placement.area==='system'");
  expect(source).toContain('availableWorkspaces.length > 1');
 });
 it('keeps scrolling inside the navigation and the Classic rail collapse outside that container',()=>{
  expect(source).toContain('overflow-y-auto overflow-x-hidden');
  const collapse=source.indexOf("aria-label={collapsed ? t('expand') : t('collapse')}");
  expect(collapse).toBeGreaterThan(0);
  const navClose=source.lastIndexOf('</nav>',collapse);
  expect(navClose).toBeGreaterThan(source.indexOf('data-app-sidebar'));
  expect(source.slice(navClose,collapse)).toContain('onClick={toggle}');
 });
 it('keeps workspace selection, module collapse and route ownership independent',()=>{
  expect(source).toContain('setWorkspaceChoice(workspace)');
  // A disabled destination (the locked Development plan) is placed but never owns the route.
  expect(source).toContain('navigationRouteOwner(pathname, search, destinations.filter(row => !row.disabled))');
  expect(source).toContain('setRailKids({})');
  expect(source).not.toContain('disabled={group.labelKey === activeSectionKey}');
 });
 it('pins System Configuration and Security Center as two module rows with their own fly-outs (board 8fa0a31d r2)',()=>{
  const start=source.indexOf('const administrationRows: CollapsibleGroupItem[] = [');
  expect(start).toBeGreaterThan(-1);
  const block=source.slice(start,source.indexOf('];',start));
  expect(block).toContain("labelKey:'systemConfiguration',icon:Settings2,children:otherSystemRows");
  expect(block).toContain("labelKey:'securityCenter',icon:ShieldCheck");
  expect(block.indexOf("'systemConfiguration'")).toBeLessThan(block.indexOf("'securityCenter'"));
  // A single trigger like Payroll: no landing link splitting the row; the overview is breadcrumb-only.
  expect(block).not.toContain('defaultHref');expect(block).toContain('landingHref:securityLanding');
  expect(source).toContain('...(administrationRows.length ? [{pinEnd:true,items:administrationRows}] : [])');
  expect(source.match(/gi===firstPinnedGroup&&'mt-auto'/g)).toHaveLength(2);
  expect(source).not.toMatch(/\bsectionNode\b|SectionBody|nav-section-heading|icon:Settings2,pinEnd/);
 });
 it('renders named module triggers in the icon rail and restores keyboard focus from flyouts',()=>{
  expect(source).toContain('collapsed={collapsed}');
  expect(source).toContain('triggerRefs.current[openNode.labelKey]?.focus()');
  expect(source).toContain('onEscape={() =>');
 });
});
