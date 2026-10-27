/** Same canonical hash used for Android's attestation challenge. Hashing does not verify enrollment. */
import {CryptoDigestAlgorithm,CryptoEncoding,digestStringAsync} from 'expo-crypto';
import {androidEnrollmentClientData,androidEnrollmentAliasData,androidNativeKeyReferenceData} from '../../lib/mobile-android-enrollment';
import {nativeKeyBindingData} from '../../lib/mobile-key-enrollment';
export async function androidEnrollmentClientDataHash(input:unknown,assertCurrent:()=>void){
 assertCurrent();const canonical=androidEnrollmentClientData(input);
 try{const result=await digestStringAsync(CryptoDigestAlgorithm.SHA256,canonical,{encoding:CryptoEncoding.BASE64});assertCurrent();return result;}
 catch(error){assertCurrent();throw error;}
}
export async function androidEnrollmentAlias(input:unknown,assertCurrent:()=>void){
 assertCurrent();const canonical=androidEnrollmentAliasData(input);
 try{const value=await digestStringAsync(CryptoDigestAlgorithm.SHA256,canonical,{encoding:CryptoEncoding.HEX});assertCurrent();return 'aihr_'+value;}
 catch(error){assertCurrent();throw error;}
}
/** Match a server receipt to the saved SDK public key, not a caller label or reported hardware tier. */
export async function androidEnrollmentNativeKeyBinding(challengeId:string,publicKeySpki:string,assertCurrent:()=>void){
 assertCurrent();const reference=androidNativeKeyReferenceData(publicKeySpki);
 try{
  const keyId=await digestStringAsync(CryptoDigestAlgorithm.SHA256,reference,{encoding:CryptoEncoding.BASE64});assertCurrent();
  const binding=await digestStringAsync(CryptoDigestAlgorithm.SHA256,nativeKeyBindingData(challengeId,keyId),{encoding:CryptoEncoding.HEX});assertCurrent();return binding;
 }catch(error){assertCurrent();throw error;}
}
