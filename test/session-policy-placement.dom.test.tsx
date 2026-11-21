/** Board f3edc521 / ADR-0171 amendment (10 November 2026): Automatic sign-out is edited on Security Center >
 * Password Policy and no longer on System Configuration > Login & browser appearance. Same owner
 * (core/session-policy), same saved row, same group-administrator authority. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import PasswordPolicyPage from '../app/admin/security-center/password-policy/page';
import LoginPresentationPage from '../app/admin/settings/login/page';
import {DEFAULT_PASSWORD_POLICY} from '../lib/password-policy';
import {DEFAULT_LOGIN_PRESENTATION} from '../lib/login-presentation';
import {rememberedMfaCopy} from '../lib/remembered-mfa-copy';
import en from '../messages/en.json';

type Grant={role:string;companyId:string|null};
const groupAdmin={tenantId:'tenant',userId:'admin',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}] as Grant[]};
const companyAdmin={tenantId:'tenant',userId:'company-admin',roles:['hr_admin'],grants:[{role:'hr_admin',companyId:'company-a'}] as Grant[]};
const employee={tenantId:'tenant',userId:'employee',roles:['employee'],grants:[{role:'employee',companyId:'company-a'}] as Grant[]};

const state = vi.hoisted(() => ({
  internal: true,
  session: null as unknown,
  readSession: vi.fn(async (_session: unknown) => ({idleTimeoutMinutes: 30, revision: 4})),
  readMfa: vi.fn(async (_session: unknown) => ({policy: {rememberDays: 7}, revision: 3})),
  readPresentation: vi.fn(async (_session: unknown) => ({presentation: {} as import('../lib/login-presentation').LoginPresentation, revision: 2})),
}));

vi.mock('next/navigation', () => ({
  redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); },
  useRouter: () => ({replace: vi.fn()}),
}));
vi.mock('../lib/session', () => ({getSession: async () => state.session}));
vi.mock('../lib/authz', async () => {
  const model = await vi.importActual<typeof import('../lib/authz-model')>('../lib/authz-model');
  return {
    isAdmin: model.isAdmin,
    isGroupAdmin: model.isGroupAdmin,
    requireAdmin: async () => {
      if (!model.isAdmin(state.session as never)) throw new Error('REDIRECT:/');
      return state.session;
    },
  };
});
vi.mock('../core/access-configuration-editor', () => ({canConfigureAccess: async () => false}));
vi.mock('../lib/scope', () => ({scopedAdmin: async () => ({s: state.session, scopeIds: []})}));
vi.mock('../core/password-policy', () => ({
  readPasswordPolicy: vi.fn(async () => ({policy: DEFAULT_PASSWORD_POLICY, revision: 0})),
}));
vi.mock('../core/remembered-mfa-policy', () => ({
  readRememberedMfaPolicyEditor: (session: unknown) => state.readMfa(session),
}));
vi.mock('../core/session-policy', () => ({
  readSessionPolicyEditor: (session: unknown) => state.readSession(session),
}));
vi.mock('../core/login-presentation', () => ({
  readLoginPresentationEditor: (session: unknown) => state.readPresentation(session),
}));
vi.mock('../lib/login-presentation-server', () => ({loginPresentationTenantId: async () => 'tenant'}));
vi.mock('../lib/internal-auth/config', () => ({internalSelected: () => state.internal}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (namespace: string) => (key: string) =>
    ((en as unknown as Record<string, Record<string, unknown>>)[namespace]?.[key] as string | undefined) ?? key),
}));
vi.mock('../app/admin/users/security-page', () => ({
  SecurityPageHeader: ({title}: {title: string}) => <h1>{title}</h1>,
}));
vi.mock('../app/admin/security-center/password-policy/actions', () => ({saveFullPasswordPolicy: vi.fn()}));
vi.mock('../app/admin/settings/login/remembered-mfa-actions', () => ({saveRememberedMfaAction: vi.fn()}));
vi.mock('../app/admin/settings/login/actions', () => ({saveSessionPolicyAction: vi.fn(), saveLoginPresentationAction: vi.fn()}));

const wrap = (node: React.ReactNode) => render(<NextIntlClientProvider locale="en" messages={en}>{node}</NextIntlClientProvider>);
const signOutHeading = () => screen.queryByRole('heading', {name: en.sessionTimeout.settingsTitle});

beforeEach(() => {
  state.readPresentation.mockImplementation(async () => ({presentation: DEFAULT_LOGIN_PRESENTATION, revision: 2}));
});
afterEach(() => {
  cleanup();
  state.internal = true;
  state.session = null;
  state.readSession.mockClear();
  state.readMfa.mockClear();
  state.readPresentation.mockClear();
});

describe('Automatic sign-out on Security Center > Password Policy', () => {
  it('shows the organisation\'s saved limit as the third section with its own save button', async () => {
    state.session = groupAdmin;
    wrap(await PasswordPolicyPage());
    expect(signOutHeading()).toBeInTheDocument();
    const minutes = screen.getByRole('spinbutton', {name: en.sessionTimeout.minutesLabel});
    expect(minutes).toHaveValue(30);
    expect(minutes).toHaveAttribute('min', '5');
    expect(minutes).toHaveAttribute('max', '480');
    expect(minutes).toHaveAttribute('name', 'idleTimeoutMinutes');
    const form = minutes.closest('form')!;
    expect(form.querySelector('input[name="revision"]')).toHaveValue('4');
    const forms = [...document.querySelectorAll('form')];
    expect(forms).toHaveLength(3);
    // Password rules first, authenticator frequency second, Automatic sign-out last.
    expect(forms[1]).toBe(screen.getByRole('spinbutton', {name: rememberedMfaCopy('en').days}).closest('form'));
    expect(forms[2]).toBe(form);
    expect(form.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(screen.getByRole('button', {name: en.sessionTimeout.save})).toBeInTheDocument();
    // Separate save actions: the sign-out form carries none of the password-rule fields.
    expect(form.querySelector('input[name="minLength"]')).toBeNull();
    expect(forms[0].querySelector('input[name="idleTimeoutMinutes"]')).toBeNull();
    expect(state.readSession).toHaveBeenCalledTimes(1);
    expect(state.readSession).toHaveBeenCalledWith(groupAdmin);
  });

  it('shows the default 15 minutes when the organisation never saved a limit', async () => {
    state.session = groupAdmin;
    state.readSession.mockImplementationOnce(async () => ({idleTimeoutMinutes: 15, revision: 0}));
    wrap(await PasswordPolicyPage());
    const minutes = screen.getByRole('spinbutton', {name: en.sessionTimeout.minutesLabel});
    expect(minutes).toHaveValue(15);
    expect(minutes.closest('form')!.querySelector('input[name="revision"]')).toHaveValue('0');
  });

  it('turns away a company-scoped HR administrator before the saved limit is read', async () => {
    state.session = companyAdmin;
    await expect(PasswordPolicyPage()).rejects.toThrow('REDIRECT:/admin/security-center');
    expect(state.readSession).not.toHaveBeenCalled();
  });

  it('turns away an employee before the saved limit is read', async () => {
    state.session = employee;
    await expect(PasswordPolicyPage()).rejects.toThrow('REDIRECT:/');
    expect(state.readSession).not.toHaveBeenCalled();
  });

  it('does not read or show the limit when the built-in sign-in is not selected', async () => {
    state.session = groupAdmin;
    state.internal = false;
    wrap(await PasswordPolicyPage());
    expect(signOutHeading()).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', {name: en.sessionTimeout.minutesLabel})).not.toBeInTheDocument();
    expect(state.readSession).not.toHaveBeenCalled();
  });

  it('fails the page instead of showing a stale value when the owner refuses the read', async () => {
    state.session = groupAdmin;
    state.readSession.mockImplementationOnce(async () => { throw new Error('forbidden'); });
    await expect(PasswordPolicyPage()).rejects.toThrow('forbidden');
  });
});

describe('Login & browser appearance no longer carries Automatic sign-out', () => {
  it('keeps only the sign-in page look for a group administrator', async () => {
    state.session = groupAdmin;
    for (const internal of [true, false]) {
      state.internal = internal;
      wrap(await LoginPresentationPage());
      expect(screen.getByRole('button', {name: en.loginPresentation.save})).toBeInTheDocument();
      expect(signOutHeading()).not.toBeInTheDocument();
      expect(screen.queryByRole('spinbutton', {name: en.sessionTimeout.minutesLabel})).not.toBeInTheDocument();
      expect(screen.queryByText(en.sessionTimeout.notEnforced)).not.toBeInTheDocument();
      expect(document.querySelectorAll('form')).toHaveLength(1);
      cleanup();
    }
    expect(state.readPresentation).toHaveBeenCalledTimes(2);
    expect(state.readSession).not.toHaveBeenCalled();
  });

  it('still turns away a company-scoped HR administrator', async () => {
    state.session = companyAdmin;
    await expect(LoginPresentationPage()).rejects.toThrow('REDIRECT:/');
    expect(state.readPresentation).not.toHaveBeenCalled();
    expect(state.readSession).not.toHaveBeenCalled();
  });
});
