import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkplaceSetupLink, workplaceSetupLinks } from '../lib/mobile-workplace-setup';
import en from '../messages/en.json';

function link() {
  const pair=generateKeyPairSync('ed25519'),now=Math.floor(Date.now()/1000);
  const bytes=Buffer.from(JSON.stringify({connectionVersion:1,apiVersion:'v1',authProvider:'internal',id:'cloud',name:'Acme',hosting:'cloud',
    apiOrigin:'https://cloud.example.test',issuer:'https://cloud.example.test/auth',clientId:'aihr-mobile',audience:'aihr-api',organization:'acme',notBefore:now-60,expiresAt:now+86400}));
  return workplaceSetupLinks(JSON.stringify({keyId:'test',payload:bytes.toString('base64url'),signature:sign(null,bytes,pair.privateKey).toString('base64url')}));
}
function fixture(href: string) {
  const listeners=new Map<string,()=>void>(),location=new URL(href);
  const history={replaceState:vi.fn((_state:unknown,_title:string,path:string)=>{location.href=new URL(path,location.origin).href;})};
  const fetcher=vi.fn(),output={exports:{} as {MobileSetupLink:React.ComponentType}};
  runInNewContext(transpileModule(readFileSync('app/(auth)/login/mobile-setup/setup-link.tsx','utf8'),{compilerOptions:{module:ModuleKind.CommonJS,jsx:JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,
    {exports:output.exports,module:output,window:{location,history,addEventListener:(event:string,fn:()=>void)=>listeners.set(event,fn),removeEventListener:(event:string)=>listeners.delete(event)},fetch:fetcher,
      require(id:string){if(id==='react')return React;if(id==='react/jsx-runtime')return jsx;if(id==='next-intl')return{useTranslations:()=>((key:keyof typeof en.mobileSetup)=>en.mobileSetup[key])};
        if(id==='@/lib/mobile-workplace-setup')return{readWorkplaceSetupLink,workplaceSetupLinks};throw new Error(id);}});
  return {View:output.exports.MobileSetupLink,location,history,fetcher,listeners};
}
afterEach(cleanup);
describe('HTTPS workplace handoff — shipped page',()=>{
  it('offers an explicit app link, removes setup from history and survives React StrictMode',async()=>{
    const links=link(),f=fixture(links.web);render(<React.StrictMode><f.View/></React.StrictMode>);
    const button=await screen.findByRole('link',{name:en.mobileSetup.open});expect(button).toHaveAttribute('href',links.app);
    expect(f.location.hash).toBe('');expect(f.fetcher).not.toHaveBeenCalled();expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(en.mobileSetup.network)).toBeInTheDocument();
  });
  it('refuses a different web origin and malformed setup rather than offering an app link',async()=>{
    for(const url of [link().web.replace('cloud.example.test','attacker.test'),'https://cloud.example.test/login/mobile-setup#setup=malformed']){
      const f=fixture(url),view=render(<f.View/>);expect(await screen.findByRole('alert')).toHaveTextContent(en.mobileSetup.invalid);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();expect(f.fetcher).not.toHaveBeenCalled();view.unmount();
    }
  });
  it('handles another setup link opened into the already mounted landing page',async()=>{
    const f=fixture(link().web);render(<f.View/>);await screen.findByRole('link');
    act(()=>{f.location.hash='#setup=invalid';f.listeners.get('hashchange')?.();});
    expect(await screen.findByRole('alert')).toBeInTheDocument();expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
