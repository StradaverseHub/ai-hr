/** Same canonical hash used for Android's attestation challenge. Hashing does not verify enrollment. */
import {CryptoDigestAlgorithm,CryptoEncoding,digestStringAsync} from 'expo-crypto';
import {androidEnrollmentClientData,androidEnrollmentAliasData} from '../../lib/mobile-android-enrollment';
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
