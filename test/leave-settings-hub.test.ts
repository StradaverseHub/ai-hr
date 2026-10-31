import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEAVE_ADMIN_DESTINATIONS, LEAVE_SETTINGS_DESTINATIONS, LEAVE_SETTINGS_HREF, leavePack } from '../packs/leave';
import { SCREENS, canReach } from '../lib/permissions';
import { isNavRowActive } from '../components/nav-flyout';
import { LEAVE_CONFIG_MAP } from '../components/leave-config-map';
const root = path.resolve(__dirname, '..');
const sidebar = leavePack.navNodes!.find(node => node.group === 'admin')!;
const expectedSettings = [
  '/admin/leave-config/types', '/admin/leave-config/balance-health', '/admin/leave-config/generate',
  '/admin/leave-config/earned-accrual', '/admin/leave-config/approval-chains',
  '/admin/leave-config/company-rules', '/admin/leave-config/special-setting',
];
const expectedOperations = [
  '/admin/leave-config/adjustments', '/admin/leave-config/data-import',
  '/admin/leave-config/leave-credit', '/leave/employee-balances',
];
describe('Leave Settings retains every destination with exactly one menu owner', () => {
  it('moves exactly the seven approved destinations into Settings, retaining operations in order', () => {
    expect(LEAVE_SETTINGS_DESTINATIONS.map(row => row.href)).toEqual(expectedSettings);
    expect(sidebar.children.map(row => row.href)).toEqual([...expectedOperations, LEAVE_SETTINGS_HREF]);
    expect([...LEAVE_SETTINGS_DESTINATIONS.map(row => row.href), ...expectedOperations].sort())
      .toEqual(LEAVE_ADMIN_DESTINATIONS.children.map(row => row.href).sort());
    for (const row of LEAVE_SETTINGS_DESTINATIONS) {
      expect(LEAVE_ADMIN_DESTINATIONS.children).toContain(row);
      expect(LEAVE_CONFIG_MAP.find(group => group.navKey === row.labelKey)?.items[0].href).toBe(row.href);
    }
  });
  it('keeps the original route and permission owner for every card, and admin-only access to the hub', () => {
    const hub = SCREENS.find(screen => screen.routes.includes(LEAVE_SETTINGS_HREF))!;
    expect(hub.href).toBe(LEAVE_SETTINGS_HREF);
    expect(hub.screenKey).toBe('leaveConfig'); expect(hub.guard).toBe('requireAdmin');
    expect(canReach('hr_admin', hub)).toBe(true); expect(canReach('super_admin', hub)).toBe(true);
    for (const role of ['employee', 'manager', 'payroll_partner'] as const) expect(canReach(role, hub)).toBe(false);
    for (const row of LEAVE_SETTINGS_DESTINATIONS) {
      expect(fs.existsSync(path.join(root, `app/(app)${row.href}/page.tsx`))).toBe(true);
      const screen = SCREENS.find(screen => screen.routes.includes(row.href))!;
      expect(screen.screenKey).toBe(row.labelKey === 'leaveApprovalWorkflow' ? 'leaveApproval' : 'leaveConfig');
    }
  });
  it('highlights Settings on every moved screen/subscreen and keeps operations distinct', () => {
    const lit = (pathname: string) => sidebar.children.filter(row => isNavRowActive(pathname, '', row)).map(row => row.href);
    for (const row of LEAVE_SETTINGS_DESTINATIONS) {
      for (const href of [row.href, ...(row.ownedSubpaths ?? [])]) expect(lit(href)).toEqual([LEAVE_SETTINGS_HREF]);
    }
    for (const href of expectedOperations) expect(lit(href)).toEqual([href]);
  });
  it('has translated navigation, actions and return links in every supported language', () => {
    for (const locale of ['en','ms','ta','th','vi','zh']) {
      const messages = JSON.parse(fs.readFileSync(path.join(root, `messages/${locale}.json`), 'utf8'));
      expect(messages.nav.leaveSettings).toBeTruthy();
      expect(Object.keys(messages.leaveSettingsHub).sort()).toEqual(['back','open','subtitle','title']);
      for (const value of Object.values(messages.leaveSettingsHub)) expect(value).toBeTruthy();
    }
    const map = fs.readFileSync(path.join(root, 'components/leave-config-map.tsx'), 'utf8');
    expect(map).toContain('href={LEAVE_SETTINGS_HREF}');
    expect(map).toContain("settings('back')");
  });
});
