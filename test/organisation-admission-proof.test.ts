import {expect,it} from 'vitest';
import {createHmac} from 'node:crypto';
import {organisationAdmissionKey,organisationAdmissionClaims,signOrganisationAdmission} from '../lib/internal-auth/organisation-admission-proof';
const master='7'.repeat(64),id='11111111-1111-4111-8111-111111111111';
const claims={tenantId:id,userId:id,personId:null,issuer:'https://hr.test/auth/'+id,subject:id,bindingCreatedAt:'2026-11-03T01:02:03.000001Z',credentialDigest:'a'.repeat(64),available:true,activeUntil:null,issuedAt:100,expiresAt:60100};
it('separates the signing key and signs exact strict finite payload bytes',()=>{
 const {payload,signature}=signOrganisationAdmission(claims,master);
 expect(organisationAdmissionKey(master)).not.toEqual(Buffer.from(master,'hex'));
 expect(signature).toBe(createHmac('sha256',organisationAdmissionKey(master)).update(payload).digest('hex'));
 expect(JSON.parse(payload)).toEqual({v:1,purpose:'aihr-company-organisation-admission-v1',...claims});
 expect(payload).not.toMatch(/password|email|totp|sealed/);
});
it('rejects extra claims, nonfinite times, wrong purpose and TTL extension',()=>{
 const {payload}=signOrganisationAdmission(claims,master),parsed=JSON.parse(payload);
 for(const changed of [{...parsed,available:'true'},{...parsed,expiresAt:60101},{...parsed,expiresAt:Infinity},{...parsed,purpose:'login'},{...parsed,password:'hidden'},{...parsed,issuedAt:100.1}])expect(organisationAdmissionClaims.safeParse(changed).success).toBe(false);
 expect(()=>organisationAdmissionKey('bad')).toThrow();
});
