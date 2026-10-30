import {describe,it,expect} from 'vitest';
import {defaultEmailConfig} from '../lib/identity/email-model';
import {bindLifecycleEmailConnection,publicLifecycleSenders,emailConnections,publicEmailConnections,saveEmailConnection,testedEmailConnection,activateEmailConnection,type ConnectionState} from '../lib/internal-auth/email-connections';
const config={...defaultEmailConfig,host:'smtp.example.test',port:587,security:'starttls' as const,from:'hr@example.test',user:'hr@example.test',fromName:'OneHR'};
const revision=(s:ConnectionState)=>s.connectionsRevision??s.revision;
const state=():ConnectionState=>({revision:'initial',active:{config,password:'fictional-old-secret'}});
describe('named SMTP connections',()=>{
 it('adopts the current relay without changing its credentials, and never exposes secrets in the list',()=>{
  const s=state(),active=structuredClone(s.active);expect(Object.keys(emailConnections(s))).toEqual(['current-relay']);expect(s.active).toEqual(active);
  expect(publicEmailConnections(s)[0]).toMatchObject({name:'OneHR',active:true,hasPassword:true});expect(JSON.stringify(publicEmailConnections(s))).not.toContain('fictional-old-secret');
 });
 it('preserves existing operator drafts when the list is introduced',()=>{
  const s={...state(),drafts:{operator:{config,password:'fictional-draft-secret',id:'old-draft',testedAt:12}}};
  const rows=publicEmailConnections(s);expect(rows).toHaveLength(2);expect(rows.map(r=>r.name)).toEqual(['OneHR','OneHR (2)']);expect(JSON.stringify(rows)).not.toContain('fictional-draft-secret');
 });
 it('saves multiple connections but leaves the current sender active until tested activation',()=>{
  const s=state(),before=structuredClone(s.active);emailConnections(s);
  const saved=saveEmailConnection(s,{name:'Backup',config,password:'fictional-new-secret',revision:revision(s)});
  expect(publicEmailConnections(s)).toHaveLength(2);expect(s.active).toEqual(before);expect(s.revision).toBe('initial');
  expect(()=>activateEmailConnection(s,saved.id,saved.version,'operator',true)).toThrow();
  saved.testedAt=100_000;saved.testedBy='operator';activateEmailConnection(s,saved.id,saved.version,'operator',true,100_001);
  expect(s.revision).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(s.activeConnectionId).toBe(saved.id);expect(s.active?.password).toBe('fictional-new-secret');expect(publicEmailConnections(s).filter(r=>r.active)).toHaveLength(1);
 });
 it('does not borrow credentials from another connection, and rejects changed mailbox identity',()=>{
  const s=state();emailConnections(s);
  expect(()=>saveEmailConnection(s,{name:'New',config,revision:revision(s)})).toThrow();
  expect(()=>saveEmailConnection(s,{id:'current-relay',name:'OneHR',config:{...config,user:'other@example.test'},revision:revision(s)})).toThrow();
  expect(saveEmailConnection(s,{id:'current-relay',name:'OneHR',config,revision:revision(s)}).password).toBe('fictional-old-secret');
 });
 it('invalidates tested changes and refuses stale versions, another operator receipt, or expired proof',()=>{
  const s=state();emailConnections(s);const c=saveEmailConnection(s,{id:'current-relay',name:'OneHR',config,revision:revision(s)});c.testedAt=100_000;c.testedBy='operator';
  expect(()=>activateEmailConnection(s,c.id,c.version,'other',true,100_001)).toThrow();expect(()=>activateEmailConnection(s,c.id,c.version,'operator',false,100_001)).toThrow();expect(()=>activateEmailConnection(s,c.id,c.version,'operator',true,2_000_001)).toThrow();
  const updated=saveEmailConnection(s,{id:c.id,name:'Renamed',config,revision:revision(s)});expect(updated.testedAt).toBeNull();expect(()=>testedEmailConnection(s,c.id,c.version)).toThrow();
  expect(publicEmailConnections(s).find(r=>r.id===c.id)?.hasUnappliedChanges).toBe(true);
 });
 it('rejects stale editors and object-prototype identifiers',()=>{
  const s=state();emailConnections(s);expect(()=>saveEmailConnection(s,{id:'current-relay',name:'OneHR',config,revision:'stale'})).toThrow();
  expect(()=>saveEmailConnection(s,{id:'__proto__',name:'Invalid',config,revision:revision(s)})).toThrow();expect(()=>testedEmailConnection(s,'constructor','x')).toThrow();
 });
 it('requires a fresh test if another administrator switched the active relay',()=>{
  const s=state();emailConnections(s);const c=saveEmailConnection(s,{name:'Candidate',config,password:'fictional-candidate-secret',revision:revision(s)});
  c.testedAt=100_000;c.testedBy='operator';s.revision='changed-by-another-activation';
  expect(()=>activateEmailConnection(s,c.id,c.version,'operator',true,100_001)).toThrow();
 });
});

it('binds only a tested received version per tenant/profile and preserves the installation default',()=>{
 const s=state(),tenant='11111111-1111-4111-8111-111111111111';emailConnections(s);const before=structuredClone(s.active),globalRevision=s.revision;
 for(const profile of ['onboarding','hr','noreply'] as const){
  const c=saveEmailConnection(s,{name:profile,config:{...config,from:profile+'@example.test'},password:'fictional-'+profile,revision:revision(s)});
  expect(()=>bindLifecycleEmailConnection(s,tenant,profile,c.id,c.version,'operator',true,100001)).toThrow();
  c.testedAt=100000;c.testedBy='operator';expect(()=>bindLifecycleEmailConnection(s,tenant,profile,c.id,c.version,'operator',false,100001)).toThrow();
  expect(()=>bindLifecycleEmailConnection(s,tenant,profile,c.id,c.version,'other',true,100001)).toThrow();
  bindLifecycleEmailConnection(s,tenant,profile,c.id,c.version,'operator',true,100001);
 }
 expect(s.active).toEqual(before);expect(s.revision).toBe(globalRevision);
 expect(publicLifecycleSenders(s,tenant).map(sender=>sender.from)).toEqual(['onboarding@example.test','hr@example.test','noreply@example.test']);
 expect(publicLifecycleSenders(s,'22222222-2222-4222-8222-222222222222').map(sender=>sender.from)).toEqual([config.from,config.from,config.from]);
 const bound=s.lifecycleSenders![tenant]!.hr!,connection=s.connections![bound.connectionId];
 saveEmailConnection(s,{id:connection.id,name:connection.name,config:{...config,from:'new-hr@example.test'},password:'fictional-new',revision:revision(s)});
 expect(bound.relay.config.from).toBe('hr@example.test');expect(publicLifecycleSenders(s,tenant).find(sender=>sender.profile==='hr')).toMatchObject({from:'hr@example.test',hasUnappliedChanges:true});
 expect(JSON.stringify(publicLifecycleSenders(s,tenant))).not.toContain('fictional-');
 expect(()=>bindLifecycleEmailConnection(s,tenant,'hr',connection.id,connection.version,'operator',true,100001)).toThrow();
});

it('rejects a stale receipt after another administrator changes the sender bindings',()=>{
 const s=state(),tenant='11111111-1111-4111-8111-111111111111';emailConnections(s);
 const a=saveEmailConnection(s,{name:'First',config,password:'fictional-first',revision:revision(s)}),b=saveEmailConnection(s,{name:'Second',config,password:'fictional-second',revision:revision(s)});
 for(const c of [a,b]){c.testedAt=100000;c.testedBy='operator';}
 bindLifecycleEmailConnection(s,tenant,'hr',a.id,a.version,'operator',true,100001);
 expect(()=>bindLifecycleEmailConnection(s,tenant,'hr',b.id,b.version,'operator',true,100001)).toThrow();expect(s.lifecycleSenders![tenant]!.hr!.connectionId).toBe(a.id);
});

it('reports legacy version-marker reuse while retaining the actual confirmed sender snapshot',()=>{
 const s=state(),tenant='11111111-1111-4111-8111-111111111111';emailConnections(s);const c=s.connections!['current-relay'];c.testedAt=100000;c.testedBy='operator';c.testedAgainstRevision=s.revision;
 bindLifecycleEmailConnection(s,tenant,'hr',c.id,c.version,'operator',true,100001);
 s.connections!['current-relay']={...c,config:{...config,from:'changed-default@example.test'}};
 expect(publicLifecycleSenders(s,tenant).find(sender=>sender.profile==='hr')).toMatchObject({from:config.from,hasUnappliedChanges:true});
});
