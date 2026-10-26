/** Synthetic signatures establish byte binding, not Apple or hardware provenance. */
import {generateKeyPairSync,sign,verify} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {keyEnrollmentClientData} from '../lib/mobile-key-enrollment';

const id=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const input=()=>({version:1,purpose:'device.key.enrollment',apiOrigin:'https://hr.example.com',
  installationId:id(1),tenantId:id(2),actorId:id(3),employmentId:id(4),appInstallationId:id(5),
  requestId:id(6),challengeId:id(7),nonce:'A'.repeat(43),issuedAt:1800000000000,expiresAt:1800000600000,
  target:{platform:'ios',appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production',
    requiredMetadata:{validationCategory:4,bundleVersions:['4','5']}},
});
describe('enrollment proof byte binding',()=>{
  it('matches an independent positional vector despite object order or UUID case',()=>{
    const original=input(),expected=JSON.stringify(['aihr.mobile.integrity',1,'device.key.enrollment',
      ['https://hr.example.com',id(1),id(2),id(3),id(4),id(5)],
      [id(6),id(7),'A'.repeat(43),1800000000000,1800000600000],
      ['ios','ABCDEFGHIJ.ai.stradaverse.aihr.test','production',[4,['4','5']]],
    ]);
    expect(keyEnrollmentClientData(original)).toBe(expected);
    expect(keyEnrollmentClientData({...Object.fromEntries(Object.entries(original).reverse()),actorId:original.actorId.toUpperCase(),
      target:{...Object.fromEntries(Object.entries(original.target).reverse()),requiredMetadata:{bundleVersions:['5','4','5'],validationCategory:4}},
    })).toBe(expected);
  });
  it('invalidates an old signature after changing any bound scope, challenge or target fact',()=>{
    const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),original=input();
    const signature=sign('sha256',Buffer.from(keyEnrollmentClientData(original),'utf8'),privateKey);
    const accepts=(value:unknown)=>verify('sha256',Buffer.from(keyEnrollmentClientData(value),'utf8'),publicKey,signature);
    expect(accepts(original)).toBe(true);
    const changes=[
      ...['installationId','tenantId','actorId','employmentId','appInstallationId','requestId','challengeId'].map(key=>({...original,[key]:id(9)})),
      {...original,apiOrigin:'https://other.example.com'}, {...original,nonce:'B'+'A'.repeat(42)},
      {...original,issuedAt:original.issuedAt+1}, {...original,expiresAt:original.expiresAt-1},
      ...[{appId:'ABCDEFGHIJ.ai.stradaverse.other'},{environment:'development'},
        {requiredMetadata:null},{requiredMetadata:{validationCategory:5,bundleVersions:['4','5']}},
        {requiredMetadata:{validationCategory:4,bundleVersions:['4','6']}}].map(change=>({...original,target:{...original.target,...change}})),
    ];
    for(const changed of changes)expect(accepts(changed)).toBe(false);
  });
  it('rejects unsupported domains, extra facts, malformed nonce and invalid lifetimes',()=>{
    const original=input();
    const invalid=[{...original,version:2},{...original,purpose:'attendance.clock.online'},
      ...['http://hr.example.com','https://hr.example.com/','https://user:secret@hr.example.com','https://hr.example.com/path'].map(apiOrigin=>({...original,apiOrigin})),
      {...original,nonce:'A'.repeat(42)+'B'},{...original,bootId:'private-local-only'},
      ...[original.issuedAt,original.expiresAt+1,Infinity,1800000000000.5].map(expiresAt=>({...original,expiresAt})),
      {...original,target:{...original.target,verified:true}},
      {...original,target:{...original.target,platform:'android'}},
      {...original,target:{...original.target,requiredMetadata:{validationCategory:0,bundleVersions:['4']}}},
      {...original,target:{...original.target,requiredMetadata:{validationCategory:4,bundleVersions:[]}}},
    ];
    for(const value of invalid)expect(()=>keyEnrollmentClientData(value)).toThrow();
  });
});
