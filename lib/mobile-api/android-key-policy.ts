/** Pure policy matcher. Passing this matcher alone never verifies the supplied description. */
import 'server-only';
import {z} from 'zod';
import type {decodeAndroidKeyDescription} from './android-key-description';
const digest=z.string().length(44).regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/);
const version=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(value=>value.trim()===value&&BigInt(value)<=BigInt('18446744073709551615'));
const month=z.number().int().min(200001).max(999912).refine(value=>value%100>=1&&value%100<=12);
const day=z.number().int().min(20000101).max(99991231).refine(value=>{const s=String(value),date=`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;return z.iso.date().safeParse(date).success;});
export const AndroidKeyPolicy=z.object({packageName:z.string().min(3).max(255).refine(value=>value.trim()===value).regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/),
 certificateDigests:z.array(digest).min(1).max(8).transform(values=>[...new Set(values)].sort()),
 versionCodes:z.array(version).min(1).max(20).transform(values=>[...new Set(values)].sort()),
 provisioningMetadata:z.enum(['allow_legacy','require_entity_and_lost_device']),
 securityLevels:z.array(z.enum(['tee','strongbox'])).min(1).max(2).transform(values=>[...new Set(values)]),
 minimumOsVersion:z.number().int().min(0).max(999999).nullable(),minimumOsPatchLevel:month.nullable(),
 minimumVendorPatchLevel:day.nullable(),minimumBootPatchLevel:day.nullable(),
}).strict();
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
