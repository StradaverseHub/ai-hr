/** Composed vendor/key-generation proof only. Enrollment ownership and challenge consumption are separate. */
import 'server-only';
import {AndroidKeyPolicy,AndroidKeyPolicyError,matchAndroidKeyPolicy} from './android-key-policy';
import {createAndroidKeyChainVerifier} from './android-key-chain';
export function createAndroidKeyProofVerifier(settings:unknown,ports:Parameters<typeof createAndroidKeyChainVerifier>[0]={}){
 const parsed=AndroidKeyPolicy.safeParse(settings);if(!parsed.success)throw new AndroidKeyPolicyError('configuration');
 const config=parsed.data,verify=createAndroidKeyChainVerifier(ports);
 return async(input:Parameters<ReturnType<typeof createAndroidKeyChainVerifier>>[0],signal?:AbortSignal)=>{
  const checked=await verify(input,signal);
  if(checked.lostDevice===true)throw new AndroidKeyPolicyError('lost_device');
  if(checked.certifiedSecurityLevel!==null&&(checked.certifiedSecurityLevel!==checked.description.attestationSecurityLevel||checked.certifiedSecurityLevel!==checked.description.keyMintSecurityLevel))throw new AndroidKeyPolicyError('security_level');
  const matched=matchAndroidKeyPolicy(config,checked.description);
  return {verification:'google_key_generation_proof' as const,publicKey:checked.publicKey,checkedAt:checked.checkedAt,
   provisioning:checked.provisioning,factoryExpiryException:checked.factoryExpiryException,...matched};
 };
}
