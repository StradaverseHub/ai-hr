import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { fetch as nativeFetch } from 'expo/fetch';
import { config, configProblem } from './config';
import { assertAuthGeneration, completeInternalSignIn, redirectUri } from './auth';
import { readBoundedBody } from '../../lib/bounded-body';
/** Company-bound server federation. The HR server owns Microsoft tokens; native receives HR opaque tokens. */
export async function signInWithMicrosoft(organization:string,owner:number) {
  assertAuthGeneration(owner);
  if(configProblem()||config.authProvider!=='internal'||!/^[a-z0-9][a-z0-9-]{1,63}$/.test(organization.trim().toLowerCase()))throw Error('unavailable');
  const origin=config.apiUrl,redirect=redirectUri();
  const verifier=Array.from(await Crypto.getRandomBytesAsync(32),b=>b.toString(16).padStart(2,'0')).join('');
  const challenge=(await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256,verifier,{encoding:Crypto.CryptoEncoding.BASE64})).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
  const state=Crypto.randomUUID().replaceAll('-','');
  async function post(operation:string,body:Record<string,string>) {
    assertAuthGeneration(owner);
    if(config.apiUrl!==origin)throw Error('unavailable');
    const response=await nativeFetch(origin+'/login/entra/'+operation,{method:'POST',headers:{'content-type':'application/json','x-aihr-client':'native'},body:JSON.stringify(body),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20_000)});
    const result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(response,32768,20_000)));
    assertAuthGeneration(owner);
    if(!response.ok||!result||typeof result!=='object')throw Error('unavailable');
    return result;
  }
  const launch=await post('native',{organization:organization.trim().toLowerCase(),redirect,state,challenge});
  const url=new URL(launch.url);
  if(url.origin!==new URL(origin).origin||url.pathname!=='/login/entra/start'||url.username||url.password||url.hash)throw Error('unavailable');
  assertAuthGeneration(owner);
  const result=await WebBrowser.openAuthSessionAsync(url.href,redirect);
  assertAuthGeneration(owner);
  if(result.type==='cancel'||result.type==='dismiss')return false;
  if(result.type!=='success')throw Error('unavailable');
  const callback=new URL(result.url),expected=new URL(redirect);
  if(callback.protocol!==expected.protocol||callback.host!==expected.host||callback.pathname!==expected.pathname||callback.hash||callback.searchParams.get('state')!==state)throw Error('unavailable');
  const code=callback.searchParams.get('code');if(!code||!/^[A-Za-z0-9_-]{43}$/.test(code))throw Error('unavailable');
  const tokens=await post('exchange',{code,verifier});
  if(tokens.step!=='complete'||!/^aihr_[A-Za-z0-9_-]{43}$/.test(tokens.access_token)||!/^aihr_refresh_[A-Za-z0-9_-]{43}$/.test(tokens.refresh_token)||!Number.isFinite(tokens.expires_in)||tokens.expires_in<=0||tokens.expires_in>900)throw Error('unavailable');
  await completeInternalSignIn(tokens,owner);return true;
}
