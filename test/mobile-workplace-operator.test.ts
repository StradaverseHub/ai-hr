import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyCompanyProfile } from '../mobile/lib/company-profile';
import { readWorkplaceSetupLink } from '../lib/mobile-workplace-setup';
const owned: string[]=[];
afterEach(()=>{for(const dir of owned.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture() {
  const root=mkdtempSync(resolve(tmpdir(),'aihr-workplace-operator-'));owned.push(root);
  const cwd=resolve(root,'installation'),keyPath=resolve(root,'private.pem'),profilePath=resolve(root,'profile.json'),output=resolve(root,'setup');
  mkdirSync(resolve(cwd,'mobile/connections'),{recursive:true});const pair=generateKeyPairSync('ed25519');
  writeFileSync(keyPath,pair.privateKey.export({format:'pem',type:'pkcs8'}),{mode:0o600});
  const trust=[{keyId:'operator',publicKey:pair.publicKey.export({format:'jwk'}).x!}];
  writeFileSync(resolve(cwd,'mobile/connections/trust.json'),JSON.stringify(trust));
  const now=Math.floor(Date.now()/1000),profile={connectionVersion:1,apiVersion:'v1',authProvider:'internal',id:'private',name:'Private client',hosting:'on-premise',organization:'client-c',
    apiOrigin:'https://hr.client.test',issuer:'https://hr.client.test/auth',clientId:'aihr-mobile',audience:'aihr-api',notBefore:now-60,expiresAt:now+86400};
  writeFileSync(profilePath,JSON.stringify(profile));
  const run=()=>execFileSync(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('scripts/mobile-company-profile.ts'),'setup',keyPath,profilePath,output],{cwd,encoding:'utf8',timeout:15000,stdio:'pipe'});
  return {cwd,keyPath,profilePath,output,trust,profile,run};
}
describe('offline workplace setup bundle',()=>{
  it('generates a signed tenant setup, HTTPS link and QR PNG without placing a private key in the bundle',()=>{
    const f=fixture();expect(f.run()).toContain('HTTPS setup link and QR');
    expect(readdirSync(f.output).sort()).toEqual(['company.aihr.json','setup-link.txt','setup-qr.png']);
    const raw=readFileSync(resolve(f.output,'company.aihr.json'),'utf8'),link=readFileSync(resolve(f.output,'setup-link.txt'),'utf8').trim();
    expect(verifyCompanyProfile(raw,f.trust)).toMatchObject(f.profile);expect(JSON.parse(readWorkplaceSetupLink(link))).toEqual(JSON.parse(raw));
    expect(readFileSync(resolve(f.output,'setup-qr.png')).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(raw+link).not.toContain('PRIVATE KEY');expect(()=>f.run()).toThrow();
    expect(verifyCompanyProfile(readFileSync(resolve(f.output,'company.aihr.json'),'utf8'),f.trust)).toMatchObject(f.profile);
  });
  it('refuses a setup without a tenant code before creating any output bundle',()=>{
    const f=fixture(),{organization:_organization,...missing}=f.profile;writeFileSync(f.profilePath,JSON.stringify(missing));
    expect(()=>f.run()).toThrow();expect(()=>readdirSync(f.output)).toThrow();
  });
});
