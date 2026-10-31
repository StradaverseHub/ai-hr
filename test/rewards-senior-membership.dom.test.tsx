import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import en from '../messages/en.json';
import ms from '../messages/ms.json';
import zh from '../messages/zh.json';
import ta from '../messages/ta.json';
import th from '../messages/th.json';
import viMessages from '../messages/vi.json';
const actions = vi.hoisted(() => ({ preview: vi.fn(), save: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: actions.refresh }) }));
vi.mock('../app/(app)/rewards/actions', () => ({ previewSeniorMembershipAction: actions.preview, saveSeniorMembershipAction: actions.save }));
import { SeniorMembership } from '../app/(app)/rewards/[unitId]/senior-membership';

const catalogues = {en, ms, zh, ta, th, vi:viMessages};
const roster = [{employmentId:'employee-a',name:'Fictional A',employeeCode:'S-01',member:false,eligible:true,grade:'21'},{employmentId:'employee-b',name:'Fictional B',employeeCode:'S-02',member:true,eligible:true,grade:'22'}];
function show(mode: 'named-members'|'legacy-grades' = 'named-members', locale: keyof typeof catalogues = 'en') {
  return render(<NextIntlClientProvider locale={locale} messages={catalogues[locale]} onError={error => { throw error; }}>
    <SeniorMembership value={{unitId:'unit-01',revision:7,canEdit:true,mode,rows:roster}} />
  </NextIntlClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  actions.preview.mockResolvedValue({ok:true,preview:{unitId:'unit-01',revision:7,digest:'preview-bound-digest',convertingLegacy:false,rows:[{...roster[0],nextMember:true},{...roster[1],nextMember:true}]}});
  actions.save.mockResolvedValue({ok:true});
});
describe('named Senior Plan selection and confirmation', () => {
  it.each(Object.keys(catalogues) as (keyof typeof catalogues)[])('renders the searchable picker in %s without translation errors', locale => {
    show('named-members',locale);
    expect(screen.getByRole('searchbox',{name:catalogues[locale].rewards.searchSeniorMembership})).toBeVisible();
    expect(screen.getByRole('checkbox',{name:/Fictional A/})).not.toBeChecked();
    expect(screen.getByRole('checkbox',{name:/Fictional B/})).toBeChecked();
  });
  it('keeps a selected employee when search filters them out, then previews and confirms the exact selection', async () => {
    show(); const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox'), 'S-01');
    expect(screen.queryByRole('checkbox',{name:/Fictional B/})).toBeNull();
    await user.click(screen.getByRole('checkbox',{name:/Fictional A/}));
    await user.click(screen.getByRole('button',{name:en.rewards.previewSeniorMembership}));
    expect(actions.preview).toHaveBeenCalledWith('unit-01',7,{employmentIds:['employee-a','employee-b'],adoptLegacy:false});
    await user.click(await screen.findByRole('button',{name:en.rewards.confirmSeniorMembership}));
    expect(actions.save).toHaveBeenCalledWith('unit-01',7,{employmentIds:['employee-a','employee-b'],adoptLegacy:false},'preview-bound-digest');
    expect(actions.refresh).toHaveBeenCalledOnce();
  });
  it('requires explicit adoption before editing a legacy draft', async () => {
    show('legacy-grades'); const user = userEvent.setup();
    expect(screen.getByRole('checkbox',{name:/Fictional A/})).toBeDisabled();
    expect(screen.getByRole('button',{name:en.rewards.previewSeniorMembership})).toBeDisabled();
    await user.click(screen.getByRole('checkbox',{name:en.rewards.adoptNamedMembership}));
    expect(screen.getByRole('checkbox',{name:/Fictional A/})).toBeEnabled();
    await user.click(screen.getByRole('button',{name:en.rewards.previewSeniorMembership}));
    expect(actions.preview).toHaveBeenCalledWith('unit-01',7,{employmentIds:['employee-b'],adoptLegacy:true});
  });
  it('invalidates a preview when membership changes and shows a failed confirmation without reusing it', async () => {
    show(); const user = userEvent.setup();
    await user.click(screen.getByRole('button',{name:en.rewards.previewSeniorMembership}));
    expect(await screen.findByRole('button',{name:en.rewards.confirmSeniorMembership})).toBeVisible();
    await user.click(screen.getByRole('checkbox',{name:/Fictional A/}));
    expect(screen.queryByRole('button',{name:en.rewards.confirmSeniorMembership})).toBeNull();
    await user.click(screen.getByRole('button',{name:en.rewards.previewSeniorMembership}));
    actions.save.mockResolvedValue({ok:false,error:'The review changed. Preview again.'});
    await user.click(await screen.findByRole('button',{name:en.rewards.confirmSeniorMembership}));
    expect(await screen.findByRole('alert')).toHaveTextContent('The review changed. Preview again.');
    expect(screen.queryByRole('button',{name:en.rewards.confirmSeniorMembership})).toBeNull();
    expect(actions.refresh).not.toHaveBeenCalled();
  });
});
