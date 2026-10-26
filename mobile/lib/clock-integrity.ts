/** Native M04 protocol adapter. No vendor verification or attendance side effects. */
import {CryptoDigestAlgorithm,CryptoEncoding,digestStringAsync} from 'expo-crypto';
import {onlineClockClientData} from '../../lib/mobile-clock-integrity';

export async function onlineClockClientDataHash(input:unknown,assertCurrent:()=>void):Promise<string>{
  assertCurrent();
  const canonical=onlineClockClientData(input);
  const hash=await digestStringAsync(CryptoDigestAlgorithm.SHA256,canonical,{encoding:CryptoEncoding.BASE64});
  assertCurrent();
  return hash;
}
