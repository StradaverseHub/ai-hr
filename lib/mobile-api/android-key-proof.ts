/** Composed vendor/key-generation proof only. Enrollment ownership and challenge consumption are separate. */
import 'server-only';
import {AndroidKeyPolicy,AndroidKeyPolicyError,matchAndroidKeyPolicy,matchAndroidIssuerSignals} from './android-key-policy';
import {createAndroidKeyChainVerifier} from './android-key-chain';
export function createAndroidKeyProofVerifier(settings:unknown,ports:Parameters<typeof createAndroidKeyChainVerifier>[0]={}){
 const parsed=AndroidKeyPolicy.safeParse(settings);if(!parsed.success)throw new AndroidKeyPolicyError('configuration');
 const config=parsed.data,verify=createAndroidKeyChainVerifier(ports);
 return async(input:Parameters<ReturnType<typeof createAndroidKeyChainVerifier>>[0],signal?:AbortSignal)=>{
  const checked=await verify(input,signal);
  matchAndroidIssuerSignals(checked.description,checked.certifiedSecurityLevel,checked.lostDevice);
  const matched=matchAndroidKeyPolicy(config,checked.description);
  return {verification:'google_key_generation_proof' as const,publicKey:checked.publicKey,checkedAt:checked.checkedAt,
   provisioning:checked.provisioning,factoryExpiryException:checked.factoryExpiryException,...matched};
 };
}
