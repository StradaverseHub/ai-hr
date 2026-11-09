import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import copy from '../mobile/lib/internal-auth-copy.json';
import { MfaResumeContext } from '../mobile/lib/mfa-resume';
function fixture(organization?: string) {
  let generation = 0;
  let visible = true;
  class Failure extends Error { constructor(public code: string) { super(code); } }
  const auth = { authGeneration: () => generation, beginSignIn: () => ++generation, assertAuthGeneration: (owner: number) => { if (owner !== generation) throw new Error('Session changed'); }, completeInternalSignIn: vi.fn(async () => {}) };
  const request = vi.fn(), probe = vi.fn(async () => {}), router = { replace: vi.fn(), push: vi.fn() }, mark = vi.fn(async () => {});
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: React.PropsWithChildren<{accessibilityRole?:string}>) => accessibilityRole === 'header' ? <h1>{children}</h1> : <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const Input = ({ accessibilityLabel, value, onChangeText, secureTextEntry, editable }: any) => <input aria-label={accessibilityLabel} type={secureTextEntry ? 'password' : 'text'} value={value} disabled={editable === false} onChange={e => onChangeText(e.target.value)}/>;
  const output = { exports: {} as {InternalSignIn:React.ComponentType} };
  const ports: Record<string, unknown> = {
    'expo/fetch':{fetch:vi.fn()},
    '../assets/onehr-icon.png':{uri:'fixture://onehr-icon'},
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { Text, Pressable:({children,accessibilityLabel,accessibilityRole,disabled,onPress}:any)=><button aria-label={accessibilityLabel} role={accessibilityRole==='link'?'link':undefined} disabled={disabled} onClick={onPress}>{typeof children==='function'?children({pressed:false}):children}</button>, ActivityIndicator:()=>null, View:Container, ScrollView:Container, TextInput:Input, Image:({accessibilityLabel,source}:any)=><img alt={accessibilityLabel} src={source.uri}/>, StyleSheet:{create:(v:unknown)=>v} },
    'expo-router':{useRouter:()=>router,Redirect:()=>null,Stack:()=> <output.exports.InternalSignIn/>},'expo-web-browser':{openBrowserAsync:vi.fn()},
    './auth':auth,'./company-connection':{useCompanyConnection:()=>({name:'Private customer',apiOrigin:'https://hr.test',organization}),companyCopy:()=>({change:'Change company'})},
    './connection-probe':{verifyCompanyServer:probe},'./config':{config:{apiUrl:'https://hr.test'},runtimeConnections:true},
    './internal-auth':{internalAuthRequest:request,InternalSignInError:Failure},'./session':{SessionProvider:Container,useSession:()=>({status:'signedOut',visible,markSignedIn:mark})},
    './i18n':{appLocale:()=> 'en',t:(key:string)=>key==='appName'?'OneHR+':key},'./internal-auth-copy.json':copy,
    './mfa-resume':{MfaResumeContext}, './public-header':{PublicHeader:()=>null},
    './sign-in-background':{SignInBackground:()=>null}, './icon':{Icon:()=>null}, 'react-native-safe-area-context':{SafeAreaView:Container,SafeAreaProvider:Container},
    './design':{DesignText:Text,PublicDesignProvider:Container,Atmosphere:()=>null,useTenantDesign:()=>({palette:{}})},
    './ui':{colors:{},Button:({title,disabled,onPress}:any)=><button disabled={disabled} onClick={onPress}>{title}</button>},
  };
  function load(file: string, target: { exports: object }, overrides: Record<string, unknown> = {}) {
    runInNewContext(transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,
      {exports:target.exports,module:target,URL,require:(name:string)=>{
        if (name in overrides) return overrides[name];
        const key = name.replace(/^\.\.\/lib\//, './');
        if (!(key in ports)) throw new Error(name);
        return ports[key];
      }});
  }
  load('mobile/lib/internal-sign-in.tsx', output);
  const layout = { exports: {} as {default: React.ComponentType} };
  load('mobile/app/_layout.tsx', layout, {
    '../lib/api': {}, '../lib/app-shell': {}, '../lib/widget-launch': {WidgetLaunchObserver:()=>null},
    '../lib/journey-drafts': {JourneyDraftProvider:Container},
    '../lib/company-connection': {...ports['./company-connection'] as object, CompanyConnectionProvider:Container, WorkplaceReviewBoundary:Container},
    '../../lib/mobile-composition': {colorContrast:()=>1}, 'expo-font': {useFonts:()=>[true]},
    '../lib/field-typography': {}, 'expo-status-bar': {StatusBar:()=>null}, '../lib/app-lock': {},
    '../lib/preferences': {useDisplayPrefs:()=>({language:'en'})}, '../lib/push': {PushSessionWatcher:()=>null},
  });
  return { View:output.exports.InternalSignIn, Layout:layout.exports.default, setVisible:(value:boolean)=>{visible=value;}, auth,request,probe,router,mark,Failure };
}
afterEach(cleanup);
async function login(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(copy.en.organization),'alpha'); await user.type(screen.getByLabelText(copy.en.username),'employee');
  await user.type(screen.getByLabelText(copy.en.password),'Temporary fixture password 771!'); await user.click(screen.getByRole('button',{name:copy.en.signIn}));
}
describe('native embedded sign-in — rendered shipped screen',()=>{
  it.each(['cloud-alpha','cloud-beta','private-company'])('uses the signed workplace %s with only username/password entry before MFA',async organization=>{
    const f=fixture(organization),user=userEvent.setup();f.request.mockResolvedValueOnce({step:'mfa',challenge:'m'.repeat(43)});
    render(<f.View/>);expect(screen.queryByLabelText(copy.en.organization)).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Change company'})).toHaveTextContent(organization);
    await user.type(screen.getByLabelText(copy.en.username),'employee');await user.type(screen.getByLabelText(copy.en.password),'Private fixture password 771!');
    await user.click(screen.getByRole('button',{name:copy.en.signIn}));
    await screen.findByRole('heading',{name:copy.en.mfaTitle});
    expect(f.request).toHaveBeenCalledWith('login',{organization,username:'employee',password:'Private fixture password 771!'},1);
    expect(f.probe).toHaveBeenCalledOnce();expect(f.auth.completeInternalSignIn).not.toHaveBeenCalled();
  });
  it('verifies the selected server before credentials and persists only after MFA and backup-code acknowledgement',async()=>{
    const f=fixture(),user=userEvent.setup();
    f.request.mockResolvedValueOnce({step:'password',challenge:'p'.repeat(43)}).mockResolvedValueOnce({step:'enroll',challenge:'e'.repeat(43),secret:'MANUALKEY',qr:'data:image/png;base64,fixture'})
      .mockResolvedValueOnce({step:'complete',access_token:'aihr_'+'a'.repeat(43),refresh_token:'aihr_refresh_'+'b'.repeat(43),expires_in:900,recoveryCodes:['PRIVATE-RECOVERY-CODE']});
    render(<f.View/>);await login(user);
    expect(await screen.findByRole('heading',{name:copy.en.passwordTitle})).toBeInTheDocument();expect(f.probe).toHaveBeenCalledOnce();expect(f.auth.completeInternalSignIn).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(copy.en.newPassword),'A new fixture safe phrase 771!');await user.type(screen.getByLabelText(copy.en.confirmation),'A new fixture safe phrase 771!');
    await user.click(screen.getByRole('button',{name:copy.en.continue}));
    expect(await screen.findByText('MANUALKEY')).toBeInTheDocument();expect(screen.getByAltText(copy.en.qrAlt)).toBeInTheDocument();
    await user.type(screen.getByLabelText(copy.en.code),'123456');await user.click(screen.getByRole('button',{name:copy.en.continue}));
    expect(await screen.findByText('PRIVATE-RECOVERY-CODE')).toBeInTheDocument();expect(f.auth.completeInternalSignIn).not.toHaveBeenCalled();expect(f.mark).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:copy.en.codesSaved}));
    await waitFor(()=>expect(f.mark).toHaveBeenCalledOnce());expect(f.auth.completeInternalSignIn).toHaveBeenCalledOnce();expect(f.router.replace).toHaveBeenCalledWith('/');
  });
  it('never sends credentials when the selected company capability cannot be verified',async()=>{
    const f=fixture(),user=userEvent.setup();f.probe.mockRejectedValueOnce(new Error('Wrong company server'));render(<f.View/>);await login(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.en.errors.unavailable);expect(f.request).not.toHaveBeenCalled();expect(f.auth.completeInternalSignIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText(copy.en.password)).toHaveValue('');
  });
  it('shows a safe MFA refusal, clears the attempted code and keeps private screens closed',async()=>{
    const f=fixture(),user=userEvent.setup();f.request.mockResolvedValueOnce({step:'mfa',challenge:'m'.repeat(43)}).mockRejectedValueOnce(new f.Failure('invalidCode'));
    render(<f.View/>);await login(user);await screen.findByRole('heading',{name:copy.en.mfaTitle});
    await user.type(screen.getByLabelText(copy.en.codeOrRecovery),'wrong-code');await user.click(screen.getByRole('button',{name:copy.en.continue}));
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.en.errors.invalidCode);expect(screen.getByLabelText(copy.en.codeOrRecovery)).toHaveValue('');
    expect(f.auth.completeInternalSignIn).not.toHaveBeenCalled();expect(f.mark).not.toHaveBeenCalled();
  });
  it('resumes the pending code screen after the root gate hides and remounts sign-in',async()=>{
    const f=fixture(),user=userEvent.setup(),challenge='m'.repeat(43);
    f.request.mockResolvedValueOnce({step:'mfa',challenge}).mockResolvedValueOnce({step:'complete',access_token:'aihr_'+'a'.repeat(43),refresh_token:'aihr_refresh_'+'b'.repeat(43),expires_in:900});
    const view=render(<f.Layout/>);await login(user);
    await screen.findByRole('heading',{name:copy.en.mfaTitle});
    await user.type(screen.getByLabelText(copy.en.codeOrRecovery),'000000');
    f.setVisible(false);view.rerender(<f.Layout/>);
    expect(screen.queryByLabelText(copy.en.codeOrRecovery)).not.toBeInTheDocument();
    f.setVisible(true);view.rerender(<f.Layout/>);
    expect(await screen.findByLabelText(copy.en.codeOrRecovery)).toHaveValue('');
    expect(screen.queryByLabelText(copy.en.password)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(copy.en.codeOrRecovery),'123456');
    await user.click(screen.getByRole('button',{name:copy.en.continue}));
    await waitFor(()=>expect(f.mark).toHaveBeenCalledOnce());
    expect(f.request).toHaveBeenNthCalledWith(2,'mfa',{challenge,code:'123456'},1);
    expect(f.probe).toHaveBeenCalledOnce();
  });
  it('discards a saved challenge when its sign-in attempt is replaced',async()=>{
    const f=fixture(),user=userEvent.setup();f.request.mockResolvedValueOnce({step:'mfa',challenge:'m'.repeat(43)});
    const view=render(<f.Layout/>);await login(user);await screen.findByRole('heading',{name:copy.en.mfaTitle});
    f.setVisible(false);view.rerender(<f.Layout/>);
    f.auth.beginSignIn();
    f.setVisible(true);view.rerender(<f.Layout/>);
    expect(screen.getByLabelText(copy.en.password)).toHaveValue('');
    expect(screen.queryByLabelText(copy.en.codeOrRecovery)).not.toBeInTheDocument();
    expect(f.request).toHaveBeenCalledOnce();
  });
  it('can retry local session completion after MFA without showing nonexistent backup codes',async()=>{
    const f=fixture(),user=userEvent.setup();
    f.request.mockResolvedValueOnce({step:'mfa',challenge:'m'.repeat(43)}).mockResolvedValueOnce({step:'complete',access_token:'aihr_'+'a'.repeat(43),refresh_token:'aihr_refresh_'+'b'.repeat(43),expires_in:900});
    f.auth.completeInternalSignIn.mockRejectedValueOnce(new Error('Device storage temporarily unavailable'));
    render(<f.View/>);await login(user);await screen.findByRole('heading',{name:copy.en.mfaTitle});
    await user.type(screen.getByLabelText(copy.en.codeOrRecovery),'123456');await user.click(screen.getByRole('button',{name:copy.en.continue}));
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.en.errors.unavailable);
    expect(screen.queryByText(copy.en.codesHelp)).not.toBeInTheDocument();expect(screen.queryByRole('button',{name:copy.en.codesSaved})).not.toBeInTheDocument();
    expect(f.mark).not.toHaveBeenCalled();expect(f.router.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button',{name:copy.en.signIn}));
    await waitFor(()=>expect(f.mark).toHaveBeenCalledOnce());expect(f.auth.completeInternalSignIn).toHaveBeenCalledTimes(2);expect(f.request).toHaveBeenCalledTimes(2);expect(f.router.replace).toHaveBeenCalledWith('/');
  });
});
