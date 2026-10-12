import React, { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import messages from '../messages/en.json';
import type { SessionContext } from '../db/client';
import type { AttendanceRuleView } from '../core/attendance-rule';

const { router } = vi.hoisted(() => ({ router: { push: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/admin/attendance/schedule/group/edit' }));
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages, namespace: namespace as never, onError: e => { throw e; } }) }));
vi.mock('../core/attendance-rule', () => ({ countEmploymentsInRule: async () => 0 }));
vi.mock('../core/roster', () => ({ listShiftsForTenant: async () => [] }));
vi.mock('../packs/attendance/service', () => ({ getScheduleRotation: async () => ({ versions: [], revision: 'r1' }) }));
vi.mock('../app/admin/attendance-policy/rules/rule-form', () => ({ RuleForm: () => null }));
vi.mock('../components/schedule-rotation-editor', () => ({ ScheduleRotationEditor: () => null }));
vi.mock('../app/admin/attendance/schedule/actions', () => ({ saveScheduleGroupAttendanceAction: vi.fn(), saveScheduleGroupOvertimeAction: vi.fn() }));

import { ScheduleGroupSections } from '../app/admin/attendance/schedule/group-sections';
import { AttendanceSettingsNavigation } from '../components/attendance-settings-navigation';
import { AttendanceSettingsActionForm } from '../components/attendance-settings-action-form';
import { saveScheduleGroupAttendanceAction } from '../app/admin/attendance/schedule/actions';
import { __resetUnsavedGuards, hasUnsavedChanges } from '../lib/unsaved-changes';
afterEach(() => { cleanup(); __resetUnsavedGuards(); vi.restoreAllMocks(); router.push.mockReset(); vi.mocked(saveScheduleGroupAttendanceAction).mockReset(); });

// Resolve the real server tree and mount its two independent client action forms.
// The action mock simulates Next’s RSC refresh followed by its handled redirect rejection.
function findForm(node: ReactNode, section: string): ReactElement | undefined {
  if (Array.isArray(node)) return node.map(child => findForm(child, section)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; id?: string }>(node)) return;
  if (node.type === 'section' && node.props.id === `section-${section}`) return findForm(node.props.children, 'form');
  if (section === 'form' && node.type === AttendanceSettingsActionForm) return node;
  return findForm(node.props.children, section);
}
const rule: AttendanceRuleView = {
  id: 'group', tenantId: 'tenant', companyId: null, description: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  name: 'Day group', isDefault: false, status: 'active',
  weeklyPattern: [1, 2, 3, 4, 5], halfPattern: [], offPattern: [],
  lateGracePeriodMinutes: 0, lateAfterMinutes: 0, lateDeductMinutes: 0, includeGraceInLateness: false,
  earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0, earlyDeductMinutes: 0, includeGraceInEarlyOut: false,
  applyToEarlyOt: false, applyDeductions: false, deductionsEffectiveFrom: null,
  otRows: [{ id: 'original-band-id', tenantId: 'tenant', ruleId: 'group', sortOrder: 0, createdAt: new Date('2026-01-01T00:00:00Z'), fromMinutes: 0, toMinutes: 120, ratePattern: 'flat', rate: '1.5', phRate: null, roundingMode: 'down', roundToMinutes: 15 }],
};
async function page(bandId: string, receipt?: string) {
  const refreshed = { ...rule, lateGracePeriodMinutes: receipt ? 5 : 0, otRows: [{ ...rule.otRows[0], id: bandId }] };
  const tree = await ScheduleGroupSections({ s: {} as SessionContext, rule: refreshed, rules: [refreshed], mode: 'edit', savedSection: receipt ? 'attendance' : undefined, savedReceipt: receipt });
  const forms = ['attendance', 'overtime'].map(section => {
    const form = findForm(tree, section);
    expect(form, `real ${section} form`).toBeDefined();
    return cloneElement(form as ReactElement<React.ComponentProps<typeof AttendanceSettingsActionForm>>, { key: section, 'aria-label': section });
  });
  return <NextIntlClientProvider locale="en" messages={messages}><AttendanceSettingsNavigation /><a href="/admin/attendance/settings">Back</a>{forms}</NextIntlClientProvider>;
}

describe('independent Schedule Group forms after a server refresh', () => {
  it('keeps the refused section dirty when its handled redirect contains no success receipt', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(await page('original-band-id'));
    const attendance = screen.getByRole('form', {name:'attendance'}) as HTMLFormElement;
    const grace = attendance.querySelector<HTMLInputElement>('[name="lateGracePeriodMinutes"]')!;
    fireEvent.change(grace, {target:{value:'5'}});
    vi.mocked(saveScheduleGroupAttendanceAction).mockImplementationOnce(async () => {
      view.rerender(await page('new-database-band-id'));
      throw Object.assign(new Error('NEXT_REDIRECT'), {digest:'NEXT_REDIRECT;push;/admin/attendance/schedule/group/edit?error=refused;303;',handled:true});
    });
    fireEvent.submit(attendance);
    await waitFor(() => expect((attendance.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
    expect(saveScheduleGroupAttendanceAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('form', {name:'attendance'})).toBe(attendance);
    expect(grace.value).toBe('5');
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('retains an unsaved overtime rounding draft when an Attendance save replaces every band id', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const view = render(await page('original-band-id'));
    const rounding = screen.getByRole('combobox', { name: messages.admin.scheduleConfig.colRoundingMode }) as HTMLSelectElement;
    const step = screen.getByRole('spinbutton', { name: messages.admin.scheduleConfig.colRoundTo }) as HTMLInputElement;
    fireEvent.change(rounding, { target: { value: 'up' } });
    fireEvent.change(step, { target: { value: '30' } });
    expect(hasUnsavedChanges()).toBe(true);
    const attendance = screen.getByRole('form', { name: 'attendance' }) as HTMLFormElement;
    const grace = attendance.querySelector<HTMLInputElement>('[name="lateGracePeriodMinutes"]')!;
    expect(grace).not.toBeNull(); fireEvent.change(grace, { target: { value: '5' } });
    let finish!: () => void; const response = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(saveScheduleGroupAttendanceAction).mockImplementationOnce(async data => {
      await response;
      view.rerender(await page('new-database-band-id', String(data.get('__attendanceSaveNonce'))));
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;push;/admin/attendance/schedule/group/edit;303;', handled: true });
    });
    expect(attendance.getAttribute('action')).toBeNull(); // No native action transition/reset.
    fireEvent.submit(attendance);
    expect(confirm).toHaveBeenCalled();
    expect(saveScheduleGroupAttendanceAction).toHaveBeenCalledTimes(1);
    const saveButton = attendance.querySelector('button[type="submit"]')! as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);
    const receipt = String(new FormData(attendance).get('__attendanceSaveNonce'));
    expect(receipt).toMatch(/^[a-f0-9]{32}$/);
    expect(vi.mocked(saveScheduleGroupAttendanceAction).mock.calls[0][0].get('__attendanceSaveNonce')).toBe(receipt);
    fireEvent.change(grace, { target: { value: '7' } }); // A newer edit must survive the handled redirect.
    await act(async () => finish());
    await waitFor(() => expect(saveButton.disabled).toBe(false));
    expect(grace.value).toBe('7');
    // Same DOM nodes and posted draft values survive the unrelated successful save.
    expect(screen.getByRole('combobox', { name: messages.admin.scheduleConfig.colRoundingMode })).toBe(rounding);
    expect(rounding.value).toBe('up'); expect(step.value).toBe('30');
    const posted = new FormData(screen.getByRole('form', { name: 'overtime' }) as HTMLFormElement);
    expect(posted.get('roundingMode_0')).toBe('up'); expect(posted.get('roundToMinutes_0')).toBe('30');
    expect(hasUnsavedChanges()).toBe(true);
    confirm.mockClear().mockReturnValue(false);
    fireEvent.click(screen.getByText('Back'));
    expect(confirm).toHaveBeenCalled(); expect(router.push).not.toHaveBeenCalled();
    fireEvent.change(rounding, { target: { value: 'down' } });
    fireEvent.change(step, { target: { value: '15' } });
    expect(hasUnsavedChanges()).toBe(true); // The post-submit Attendance edit is still dirty too.
    fireEvent.change(grace, { target: { value: '5' } });
    expect(hasUnsavedChanges()).toBe(false); // Only the submitted value was acknowledged.
  });
});
