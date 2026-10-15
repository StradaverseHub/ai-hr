import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import copy from '../mobile/lib/internal-auth-copy.json';
function fixture() {
  let generation = 0;
  class Failure extends Error { constructor(public code: string) { super(code); } }
  const auth = { beginSignIn: () => ++generation, assertAuthGeneration: (owner: number) => { if (owner !== generation) throw new Error('Session changed'); }, completeInternalSignIn: vi.fn(async () => {}) };
  const request = vi.fn(), probe = vi.fn(async () => {}), router = { replace: vi.fn(), push: vi.fn() }, mark = vi.fn(async () => {});
  const Container = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
  const Text = ({ children, accessibilityRole }: React.PropsWithChildren<{accessibilityRole?:string}>) => accessibilityRole === 'header' ? <h1>{children}</h1> : <span role={accessibilityRole === 'alert' ? 'alert' : undefined}>{children}</span>;
  const Input = ({ accessibilityLabel, value, onChangeText, secureTextEntry, editable }: any) => <input aria-label={accessibilityLabel} type={secureTextEntry ? 'password' : 'text'} value={value} disabled={editable === false} onChange={e => onChangeText(e.target.value)}/>;
  const output = { exports: {} as {InternalSignIn:React.ComponentType} };
  const ports: Record<string, unknown> = {
    react: React, 'react/jsx-runtime': jsx,
    'react-native': { Text, View:Container, ScrollView:Container, TextInput:Input, Image:({accessibilityLabel,source}:any)=><img alt={accessibilityLabel} src={source.uri}/>, StyleSheet:{create:(v:unknown)=>v} },
    'expo-router':{router,Redirect:()=>null},'expo-web-browser':{openBrowserAsync:vi.fn()},
    './auth':auth,'./company-connection':{useCompanyConnection:()=>({name:'Private customer',apiOrigin:'https://hr.test'}),companyCopy:()=>({change:'Change company'})},
    './connection-probe':{verifyCompanyServer:probe},'./config':{config:{apiUrl:'https://hr.test'},runtimeConnections:true},
    './internal-auth':{internalAuthRequest:request,InternalSignInError:Failure},'./session':{useSession:()=>({status:'signedOut',markSignedIn:mark})},
    './i18n':{appLocale:()=> 'en'},'./internal-auth-copy.json':copy,
    './ui':{colors:{},Button:({title,disabled,onPress}:any)=><button disabled={disabled} onClick={onPress}>{title}</button>},
  };
  runInNewContext(transpileModule(readFileSync('mobile/lib/internal-sign-in.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,
    {exports:output.exports,module:output,URL,require:(name:string)=>{if(!(name in ports))throw new Error(name);return ports[name];}});
  return { View:output.exports.InternalSignIn,auth,request,probe,router,mark,Failure };
}
afterEach(cleanup);
async function login(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(copy.en.organization),'alpha'); await user.type(screen.getByLabelText(copy.en.username),'employee');
  await user.type(screen.getByLabelText(copy.en.password),'Temporary fixture password 771!'); await user.click(screen.getByRole('button',{name:copy.en.signIn}));
}
describe('native embedded sign-in — rendered shipped screen',()=>{
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
