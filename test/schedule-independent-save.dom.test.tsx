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
vi.mock('../core/schedule-group-controls', () => ({scheduleGroupControls:async()=>({label:null,dutyRosterControl:false,revisions:[]})}));
vi.mock('../core/roster', () => ({ listShiftsForTenant: async () => [] }));
vi.mock('../packs/attendance/service', () => ({ getScheduleRotation: async () => ({ versions: [],memberships:[], revision: 'r1' }) }));
vi.mock('../app/(app)/admin/attendance-policy/rule-actions', () => ({createAttendanceRuleAction:vi.fn(),updateAttendanceRuleAction:vi.fn(),saveScheduleGroupGeneralAction:vi.fn()}));
vi.mock('../components/schedule-rotation-editor', () => ({ ScheduleRotationEditor: () => null }));
vi.mock('../app/(app)/admin/attendance/schedule/actions', () => ({ saveScheduleGroupAttendanceAction: vi.fn(), saveScheduleGroupOvertimeAction: vi.fn(),saveScheduleGroupControlAction:vi.fn() }));

import { RuleForm } from '../app/(app)/admin/attendance-policy/rules/rule-form';
import { saveScheduleGroupGeneralAction } from '../app/(app)/admin/attendance-policy/rule-actions';
import { ScheduleGroupSections } from '../app/(app)/admin/attendance/schedule/group-sections';
import {ScheduleGroupTabs} from '../components/schedule-group-tabs';
import { AttendanceSettingsNavigation } from '../components/attendance-settings-navigation';
import { AttendanceSettingsActionForm } from '../components/attendance-settings-action-form';
import { saveScheduleGroupAttendanceAction, saveScheduleGroupOvertimeAction } from '../app/(app)/admin/attendance/schedule/actions';
import { __resetUnsavedGuards, hasUnsavedChanges } from '../lib/unsaved-changes';
afterEach(() => { cleanup(); __resetUnsavedGuards(); vi.restoreAllMocks(); router.push.mockReset(); vi.mocked(saveScheduleGroupAttendanceAction).mockReset();vi.mocked(saveScheduleGroupOvertimeAction).mockReset();vi.mocked(saveScheduleGroupGeneralAction).mockReset(); });

// Resolve the real server tree and mount its three independent client action forms.
// The action mock simulates Next’s RSC refresh followed by its handled redirect rejection.
function findForm(node: ReactNode, section: string): ReactElement | undefined {
  if (Array.isArray(node)) return node.map(child => findForm(child, section)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; id?: string }>(node)) return;
  if(node.type===ScheduleGroupTabs){const tabs=(node.props as React.ComponentProps<typeof ScheduleGroupTabs>).tabs;return tabs.filter(t=>section==='form'||t.id===section).map(t=>findForm(t.body,'form')).find(Boolean);}
  if (node.type === 'section' && node.props.id === `section-${section}`) return findForm(node.props.children, 'form');
  if (section === 'form' && node.type === AttendanceSettingsActionForm && !(node.props as Record<string,unknown>)['data-schedule-control']) return node;
  return findForm(node.props.children, section);
}
// Resolve only the known async General server form, never call client components outside React.
async function resolveGeneral(node:ReactNode):Promise<ReactNode> {
  if(Array.isArray(node))return Promise.all(node.map(resolveGeneral));
  if(!isValidElement<{children?:ReactNode}>(node))return node;
  if(node.type===ScheduleGroupTabs){const props=node.props as React.ComponentProps<typeof ScheduleGroupTabs>;return cloneElement(node,{...props,tabs:await Promise.all(props.tabs.map(async tab=>({...tab,body:await resolveGeneral(tab.body)})))} as never);}
  if(node.type===RuleForm)return RuleForm(node.props as React.ComponentProps<typeof RuleForm>);
  return cloneElement(node,{children:await resolveGeneral(node.props.children)});
}
const rule: AttendanceRuleView = {
  id: 'group', tenantId: 'tenant', companyId: null,label:null,dutyRosterControl:false, description: null,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
  name: 'Day group', isDefault: false, status: 'active',
  weeklyPattern: [1, 2, 3, 4, 5], halfPattern: [], offPattern: [],
  lateGracePeriodMinutes: 0, lateAfterMinutes: 0, lateDeductMinutes: 0, includeGraceInLateness: false,
  earlyGracePeriodMinutes: 0, earlyAfterMinutes: 0, earlyDeductMinutes: 0, includeGraceInEarlyOut: false,
  applyToEarlyOt: false, applyDeductions: false, deductionsEffectiveFrom: null,
  otRows: [{ id: 'original-band-id', tenantId: 'tenant', ruleId: 'group', sortOrder: 0, createdAt: new Date('2026-01-01T00:00:00Z'), fromMinutes: 0, toMinutes: 120, ratePattern: 'flat', rate: '1.5', phRate: null, roundingMode: 'down', roundToMinutes: 15 }],
};
async function page(bandId: string, receipt?: string, savedSection: 'general'|'attendance'|'overtime'='attendance', updated:Partial<AttendanceRuleView>={}) {
  const refreshed = { ...rule, lateGracePeriodMinutes: receipt && savedSection === 'attendance' ? 5 : 0, otRows: [{ ...rule.otRows[0], id: bandId }],...updated };
  const tree = await resolveGeneral(await ScheduleGroupSections({ s: {} as SessionContext, rule: refreshed, rules: [refreshed], mode: 'edit', savedSection: receipt ? savedSection : undefined, savedReceipt: receipt }));
  const forms = ['general', 'attendance', 'overtime'].map(section => {
    const form = findForm(tree, section);
    expect(form, `real ${section} form`).toBeDefined();
    return cloneElement(form as ReactElement<React.ComponentProps<typeof AttendanceSettingsActionForm>>, { key: section, 'aria-label': section });
  });
  return <NextIntlClientProvider locale="en" messages={messages}><AttendanceSettingsNavigation /><a href="/admin/attendance/settings">Back</a>{forms}</NextIntlClientProvider>;
}

describe('independent Schedule Group forms after a server refresh', () => {
  it('keeps the real General form and its dirty label while moving tabs by keyboard',async()=>{
    window.history.replaceState({},'', '/admin/attendance/schedule/group/edit');
    const tree=await resolveGeneral(await ScheduleGroupSections({s:{} as SessionContext,rule,rules:[rule],mode:'edit'}));
    render(<NextIntlClientProvider locale="en" messages={messages}><AttendanceSettingsNavigation/>{tree}</NextIntlClientProvider>);
    const panels=screen.getAllByRole('tabpanel',{hidden:true});
    expect(panels).toHaveLength(4);
    const general=screen.getByRole('tabpanel');
    const label=general.querySelector<HTMLInputElement>('input[name="label"]')!;
    expect(label).not.toBeNull();
    fireEvent.change(label,{target:{value:'OFFICE-UNSAVED'}});
    expect(hasUnsavedChanges()).toBe(true);
    const generalTab=screen.getByRole('tab',{name:messages.admin.scheduleConfig.sectionGeneral});
    fireEvent.keyDown(generalTab,{key:'ArrowRight'});
    expect(general).not.toBeVisible();
    expect(label.isConnected).toBe(true);
    expect(screen.getAllByRole('tabpanel',{hidden:true})).toEqual(panels);
    const attendanceTab=screen.getByRole('tab',{selected:true});
    fireEvent.keyDown(attendanceTab,{key:'ArrowLeft'});
    expect(screen.getByRole('tabpanel')).toBe(general);
    expect(general.querySelector('input[name="label"]')).toBe(label);
    expect(label.value).toBe('OFFICE-UNSAVED');
    expect(hasUnsavedChanges()).toBe(true);
    expect(saveScheduleGroupGeneralAction).not.toHaveBeenCalled();
  });

  it('retains independent edits across mouse tab changes and an unchanged server tree refresh',async()=>{
    window.history.replaceState({},'', '/admin/attendance/schedule/group/edit');
    const renderTree=async()=>{
      const resolved=await resolveGeneral(await ScheduleGroupSections({s:{} as SessionContext,rule,rules:[rule],mode:'edit'}));
      return <NextIntlClientProvider locale="en" messages={messages}><AttendanceSettingsNavigation/>{resolved}</NextIntlClientProvider>;
    };
    const view=render(await renderTree());
    const general=screen.getByRole('tabpanel');
    const label=general.querySelector<HTMLInputElement>('input[name="label"]')!;
    fireEvent.change(label,{target:{value:'OFFICE-DRAFT'}});
    fireEvent.click(screen.getByRole('tab',{name:messages.admin.scheduleConfig.sectionAttendance}));
    const attendance=screen.getByRole('tabpanel');
    const grace=attendance.querySelector<HTMLInputElement>('input[name="lateGracePeriodMinutes"]')!;
    fireEvent.change(grace,{target:{value:'9'}});
    view.rerender(await renderTree());
    fireEvent.click(screen.getByRole('tab',{name:messages.admin.scheduleConfig.sectionGeneral}));
    expect(general.querySelector('input[name="label"]')).toBe(label);
    expect(label.value).toBe('OFFICE-DRAFT');
    fireEvent.click(screen.getByRole('tab',{name:messages.admin.scheduleConfig.sectionAttendance}));
    expect(attendance.querySelector('input[name="lateGracePeriodMinutes"]')).toBe(grace);
    expect(grace.value).toBe('9');
    expect(hasUnsavedChanges()).toBe(true);
    expect(saveScheduleGroupGeneralAction).not.toHaveBeenCalled();
    expect(saveScheduleGroupAttendanceAction).not.toHaveBeenCalled();
  });

  it('General posts only its owned fields after a saved Overtime refresh',async()=>{
    vi.spyOn(window,'confirm').mockReturnValue(true);
    const view=render(await page('original-band-id'));
    const general=screen.getByRole('form',{name:'general'}) as HTMLFormElement;
    const overtime=screen.getByRole('form',{name:'overtime'}) as HTMLFormElement;
    fireEvent.change(overtime.querySelector('[name="roundingMode_0"]')!,{target:{value:'up'}});
    fireEvent.change(overtime.querySelector('[name="roundToMinutes_0"]')!,{target:{value:'30'}});
    vi.mocked(saveScheduleGroupOvertimeAction).mockImplementationOnce(async data=>{
      view.rerender(await page('new-band-id',String(data.get('__attendanceSaveNonce')),'overtime',{
        applyToEarlyOt:true,otRows:[{...rule.otRows[0],roundingMode:'up',roundToMinutes:30}]}));
      throw Object.assign(new Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;push;/admin/attendance/schedule/group/edit;303;',handled:true});
    });
    fireEvent.submit(overtime);
    await waitFor(()=>expect((overtime.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole('form',{name:'general'})).toBe(general);
    fireEvent.change(general.querySelector('[name="name"]')!,{target:{value:'Renamed group'}});
    vi.mocked(saveScheduleGroupGeneralAction).mockImplementationOnce(async()=>{throw Object.assign(new Error('NEXT_REDIRECT'),{digest:'NEXT_REDIRECT;push;/admin/attendance/schedule/group/edit;303;',handled:true});});
    fireEvent.submit(general);
    await waitFor(()=>expect(saveScheduleGroupGeneralAction).toHaveBeenCalledTimes(1));
    const posted=vi.mocked(saveScheduleGroupGeneralAction).mock.calls[0][0];
    expect(posted.get('name')).toBe('Renamed group');
    for(const key of ['lateGracePeriodMinutes','earlyGracePeriodMinutes','includeGraceInLateness','includeGraceInEarlyOut','applyToEarlyOt'])expect(posted.has(key)).toBe(false);
    const bands=JSON.parse(String(posted.get('otRows'))) as Record<string,unknown>[];
    expect(bands).toHaveLength(1);expect(bands[0].rate).toBe(1.5);
    expect(bands[0]).not.toHaveProperty('roundingMode');expect(bands[0]).not.toHaveProperty('roundToMinutes');
  });

  it('retains Overtime fields and identity with visible guidance after General reshapes the ladder',async()=>{
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
    const view=render(await page('original-band-id'));
    const overtime=screen.getByRole('form',{name:'overtime'}) as HTMLFormElement;
    const rounding=overtime.querySelector<HTMLInputElement>('[name="roundingMode_0"]')!;
    const identity=new FormData(overtime).get('otBandSnapshot');
    fireEvent.change(rounding,{target:{value:'up'}});
    await act(async()=>view.rerender(await page('new-band-id',undefined,'general',{
      otRows:[{...rule.otRows[0],toMinutes:60,rate:'2.0'},
        {...rule.otRows[0],id:'second-band',fromMinutes:61,toMinutes:0,roundingMode:'none',roundToMinutes:null}]})));
    expect(screen.getByRole('alert')).toHaveTextContent(messages.scheduleDrafts.staleLadder);
    expect(overtime.querySelector('[name="roundingMode_0"]')).toBe(rounding);
    expect(rounding.value).toBe('up');expect(overtime.querySelector('[name="roundingMode_61"]')).toBeNull();
    expect(new FormData(overtime).get('otBandSnapshot')).toBe(identity);
    expect(hasUnsavedChanges()).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:messages.scheduleDrafts.reload}));
    expect(confirm).toHaveBeenCalledTimes(1);expect(rounding.value).toBe('up');
  });

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
