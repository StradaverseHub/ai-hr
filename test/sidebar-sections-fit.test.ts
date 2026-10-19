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
  expect(source).toContain('navigationRouteOwner(pathname, search, destinations)');
  expect(source).toContain('setRailKids({})');
  expect(source).not.toContain('disabled={group.labelKey === activeSectionKey}');
 });
 it('renders named module triggers in the icon rail and restores keyboard focus from flyouts',()=>{
  expect(source).toContain('collapsed={collapsed}');
  expect(source).toContain('triggerRefs.current[openNode.labelKey]?.focus()');
  expect(source).toContain('onEscape={() =>');
 });
});
