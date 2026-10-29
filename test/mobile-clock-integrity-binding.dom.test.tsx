/** Real command bytes and SHA-256; synthetic keys are not vendor attestation evidence. */
import {createHash,generateKeyPairSync,sign,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {describe,expect,it,vi} from 'vitest';
import {onlineClockClientData,OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';
import {onlineClockClientDataHash} from '../lib/mobile-api/clock-integrity';

const id=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const input=()=>({version:1 as const,purpose:'attendance.clock.online' as const,
  scope:{apiOrigin:'https://hr.example.com',installationId:id(7),tenantId:id(1),actorId:id(2),employmentId:id(3),deviceKeyId:id(4)},
  challenge:{id:id(5),nonce:'A'.repeat(43),expiresAt:1900000000000},
  command:{requestId:id(6),action:'in' as 'in'|'out',lat:3.123,lng:101.456,accuracy:7.5,sampledAt:1800000000000,
    photo:{sha256:'a'.repeat(64),byteLength:123,mimeType:'image/jpeg' as const}},
  evidence:{platform:'ios' as 'ios'|'android',appId:'ai.stradaverse.aihr.test',appVersion:'1.0.3',buildVersion:'4',provider:null as string|null,
    mock:null as boolean|null,simulated:false as boolean|null,accessory:false as boolean|null},
});
function nativeHash(digest:(algorithm:unknown,value:string,options:unknown)=>Promise<string>){
  const module={exports:{} as {onlineClockClientDataHash:(input:unknown,check:()=>void)=>Promise<string>}};
  runInNewContext(transpileModule(readFileSync('mobile/lib/clock-integrity.ts','utf8'),{
    compilerOptions:{module:ModuleKind.CommonJS},
  }).outputText,{exports:module.exports,module,require:(name:string)=>{
    if(name==='expo-crypto')return {CryptoDigestAlgorithm:{SHA256:'SHA-256'},CryptoEncoding:{BASE64:'base64'},digestStringAsync:digest};
    if(name==='../../lib/mobile-clock-integrity')return {onlineClockClientData};
    throw new Error('Unexpected dependency');
  }});
  return module.exports.onlineClockClientDataHash;
}
describe('online clock integrity command binding',()=>{
  it('uses explicit versioned positional bytes rather than caller object insertion order',()=>{
    const data=input();
    const expected=JSON.stringify(['aihr.mobile.integrity',1,'attendance.clock.online',
      ['https://hr.example.com',id(7),id(1),id(2),id(3),id(4)],[id(5),'A'.repeat(43),1900000000000],
      [id(6),'in',3.123,101.456,7.5,1800000000000,['a'.repeat(64),123,'image/jpeg']],
      ['ios','ai.stradaverse.aihr.test','1.0.3','4',null,null,false,false],
    ]);
    expect(onlineClockClientData(data)).toBe(expected);
    expect(onlineClockClientData({...data,scope:Object.fromEntries(Object.entries(data.scope).reverse()),command:Object.fromEntries(Object.entries(data.command).reverse())})).toBe(expected);
    expect(onlineClockClientDataHash(data)).toEqual(createHash('sha256').update(expected,'utf8').digest());
  });
  it('binds every scope, challenge, clock and attachment fact to the signed bytes',()=>{
    const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    const original=input(),message=Buffer.from(onlineClockClientData(original),'utf8');
    const signature=sign('sha256',message,privateKey);
    expect(verify('sha256',message,publicKey,signature)).toBe(true);
    const changes=[
      ...Object.keys(original.scope).map(key=>({...original,scope:{...original.scope,[key]:key==='apiOrigin'?'https://other.example.com':id(9)}})),
      {...original,challenge:{...original.challenge,id:id(9)}},
      {...original,challenge:{...original.challenge,nonce:'B'+'A'.repeat(42)}},
      {...original,challenge:{...original.challenge,expiresAt:1900000000001}},
      ...Object.keys(original.command).filter(key=>key!=='photo').map(key=>({...original,command:{...original.command,[key]:key==='requestId'?id(9):key==='action'?'out':Number(original.command[key as 'lat'])+1}})),
      {...original,command:{...original.command,photo:null}},
      ...Object.keys(original.command.photo).map(key=>({...original,command:{...original.command,photo:{...original.command.photo,[key]:key==='sha256'?'b'.repeat(64):key==='mimeType'?'image/png':124}}})),
      ...Object.keys(original.evidence).map(key=>({...original,evidence:{...original.evidence,
        [key]:key==='platform'?'android':key==='provider'?'fused':['mock','simulated','accessory'].includes(key)?true:'changed',
      }})),
    ];
    for(const changed of changes)expect(verify('sha256',Buffer.from(onlineClockClientData(changed),'utf8'),publicKey,signature)).toBe(false);
  });
  it('normalizes UUID case only and represents absent photos explicitly',()=>{
    const original=input();
    expect(onlineClockClientData({...original,scope:{...original.scope,actorId:original.scope.actorId.toUpperCase()}})).toBe(onlineClockClientData(original));
    expect(onlineClockClientData({...original,command:{...original.command,photo:null}})).not.toBe(onlineClockClientData(original));
    expect(OnlineClockIntegrityData.safeParse({...original,command:{...original.command,photo:undefined}}).success).toBe(false);
  });
  it('preserves unavailable, true and false source flags as three different signed facts',()=>{
    const original=input();
    for(const flag of ['mock','simulated','accessory']){
      const variants=[null,false,true].map(value=>onlineClockClientData({...original,evidence:{...original.evidence,[flag]:value}}));
      expect(new Set(variants).size).toBe(3);
    }
  });
  it('rejects unsupported domains, extra fields, invalid instants, coordinates and attachment metadata',()=>{
    const original=input();
    const invalid=[{...original,version:2},{...original,purpose:'attendance.clock.offline'},
      {...original,scope:{...original.scope,apiOrigin:'http://hr.example.com'}},
      {...original,scope:{...original.scope,apiOrigin:'https://hr.example.com/'}},
      {...original,scope:{...original.scope,apiOrigin:'https://user:secret@hr.example.com'}},
      {...original,scope:{...original.scope,bootId:'must-stay-local'}},
      {...original,evidence:{...original.evidence,elapsedBeforeNs:'private-raw-uptime'}},
      {...original,challenge:{...original.challenge,nonce:'A'.repeat(42)+'B'}},
      ...[{sampledAt:1.2},{sampledAt:8640000000000001},{lat:91},{lng:Infinity},{accuracy:-1},{verified:true}].map(change=>({...original,command:{...original.command,...change}})),
      ...[{sha256:'A'.repeat(64)},{byteLength:2*1024*1024+1},{mimeType:'text/html'}].map(change=>({...original,command:{...original.command,photo:{...original.command.photo,...change}}})),
    ];
    for(const value of invalid)expect(()=>onlineClockClientData(value)).toThrow();
  });
  it('hashes identical canonical UTF-8 bytes on the native and server sides',async()=>{
    const digest=vi.fn(async(_algorithm:unknown,value:string)=>createHash('sha256').update(value,'utf8').digest('base64'));
    const hash=nativeHash(digest),check=vi.fn();
    expect(await hash(input(),check)).toBe(onlineClockClientDataHash(input()).toString('base64'));
    expect(digest).toHaveBeenCalledExactlyOnceWith('SHA-256',onlineClockClientData(input()),{encoding:'base64'});
    expect(check).toHaveBeenCalledTimes(2);
  });
  it('rejects an account change during native hashing rather than delivering the old actor digest',async()=>{
    let release!:(value:string)=>void,current=true;
    const hash=nativeHash(()=>new Promise(resolve=>{release=resolve;}));
    const check=()=>{if(!current)throw new Error('obsolete actor');};
    const pending=hash(input(),check);current=false;release('old-actor-hash');
    await expect(pending).rejects.toThrow('obsolete actor');
  });
});
