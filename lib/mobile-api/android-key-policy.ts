/** Pure policy matcher. Passing this matcher alone never verifies the supplied description. */
import 'server-only';
import type {decodeAndroidKeyDescription} from './android-key-description';
import {AndroidKeyPolicy} from '../mobile-android-key-policy';
export {AndroidKeyPolicy} from '../mobile-android-key-policy';
export class AndroidKeyPolicyError extends Error{
 constructor(readonly reason:'configuration'|'app_identity'|'security_level'|'key_properties'|'boot_state'|'patch_level'|'lost_device'|'metadata_unavailable'){
  super('Android key policy refused');this.name='AndroidKeyPolicyError';
 }
}
function fail(reason:AndroidKeyPolicyError['reason']):never{throw new AndroidKeyPolicyError(reason);}
type Description=ReturnType<typeof decodeAndroidKeyDescription>;
/** Called ONLY after the description's containing certificate path and current status are verified.
 * A match is about key-generation evidence, not current GPS, current boot state or app licensing. */
export function matchAndroidKeyPolicy(settings:unknown,description:Description){
 const parsed=AndroidKeyPolicy.safeParse(settings);if(!parsed.success)fail('configuration');
 const p=parsed.data,s=description.softwareEnforced,h=description.hardwareEnforced;
 if(!p.securityLevels.includes(description.attestationSecurityLevel as 'tee')||!p.securityLevels.includes(description.keyMintSecurityLevel as 'tee')||
   description.attestationSecurityLevel!==description.keyMintSecurityLevel)fail('security_level');
 // No shared UID package adoption or union of software and hardware authorization facts.
 const app=s.applicationId;
 if(!app||h.applicationId||app.packages.length!==1||app.packages[0].name!==p.packageName||!p.versionCodes.includes(app.packages[0].version)||
   !app.certificateDigests.length||app.certificateDigests.some(value=>!p.certificateDigests.includes(value))||
   s.allApplications||h.allApplications)fail('app_identity');
 if(h.algorithm!==3||h.keySize!==256||h.curve!==1||h.origin!==0||!h.purposes?.includes(2)||h.purposes.some(value=>value!==2&&value!==3)||
   h.digests?.length!==1||h.digests[0]!==4||s.algorithm!==undefined||s.keySize!==undefined||s.curve!==undefined||s.origin!==undefined||s.purposes!==undefined||s.digests!==undefined)fail('key_properties');
 if(!h.rootOfTrust||s.rootOfTrust||h.rootOfTrust.deviceLocked!==true||h.rootOfTrust.state!=='verified'||h.rootOfTrust.bootKeyBytes!==32||h.rootOfTrust.bootHashBytes!==32)fail('boot_state');
 if(h.osPatchLevel!==undefined&&!month.safeParse(h.osPatchLevel).success)fail('patch_level');
 for(const value of [h.vendorPatchLevel,h.bootPatchLevel])if(value!==undefined&&!month.safeParse(value).success&&!day.safeParse(value).success)fail('patch_level');
 const thresholds=[['osVersion',p.minimumOsVersion],['osPatchLevel',p.minimumOsPatchLevel],['vendorPatchLevel',p.minimumVendorPatchLevel],['bootPatchLevel',p.minimumBootPatchLevel]] as const;
 for(const [key,minimum] of thresholds){
  const value=h[key];
  if(minimum!==null&&(value===undefined||!Number.isSafeInteger(value)||value<minimum))fail('patch_level');
 }
 return {packageName:app.packages[0].name,versionCode:app.packages[0].version,securityLevel:description.keyMintSecurityLevel as 'tee'|'strongbox',
  osVersion:h.osVersion??null,osPatchLevel:h.osPatchLevel??null,vendorPatchLevel:h.vendorPatchLevel??null,bootPatchLevel:h.bootPatchLevel??null};
}

/** Pure cross-check of signed issuer/provisioning signals; requires the verified path owner. */
export function matchAndroidIssuerSignals(description:Description,certifiedSecurityLevel:'tee'|'strongbox'|null,lostDevice:boolean|null){
 if(lostDevice===true)fail('lost_device');
 if(certifiedSecurityLevel!==null&&(certifiedSecurityLevel!==description.attestationSecurityLevel||certifiedSecurityLevel!==description.keyMintSecurityLevel))fail('security_level');
}
