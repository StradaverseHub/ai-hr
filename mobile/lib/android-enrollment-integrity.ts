/** Same canonical hash used for Android's attestation challenge. Hashing does not verify enrollment. */
import {CryptoDigestAlgorithm,CryptoEncoding,digestStringAsync} from 'expo-crypto';
import {androidEnrollmentClientData} from '../../lib/mobile-android-enrollment';
export async function androidEnrollmentClientDataHash(input:unknown,assertCurrent:()=>void){
 assertCurrent();const canonical=androidEnrollmentClientData(input);
 try{const result=await digestStringAsync(CryptoDigestAlgorithm.SHA256,canonical,{encoding:CryptoEncoding.BASE64});assertCurrent();return result;}
 catch(error){assertCurrent();throw error;}
}
