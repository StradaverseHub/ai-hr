import {describe,it,expect} from 'vitest';
import {defaultEmailConfig} from '../lib/identity/email-model';
import {resolveLifecycleSender} from '../lib/internal-auth/active-relay';
import {bindLifecycleEmailConnection,nameLifecycleSender,publicLifecycleSenders,emailConnections,publicEmailConnections,saveEmailConnection,testedEmailConnection,activateEmailConnection,type ConnectionState} from '../lib/internal-auth/email-connections';
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

it('binds only a tested received version to the single tenant sender and preserves the installation default',()=>{
 const s=state(),tenant='11111111-1111-4111-8111-111111111111';emailConnections(s);const before=structuredClone(s.active),globalRevision=s.revision;
 const c=saveEmailConnection(s,{name:'Lifecycle',config:{...config,from:'lifecycle@example.test'},password:'fictional-lifecycle',revision:revision(s)});
 expect(()=>bindLifecycleEmailConnection(s,tenant,c.id,c.version,'operator',true,100001)).toThrow();
 c.testedAt=100000;c.testedBy='operator';expect(()=>bindLifecycleEmailConnection(s,tenant,c.id,c.version,'operator',false,100001)).toThrow();
 expect(()=>bindLifecycleEmailConnection(s,tenant,c.id,c.version,'other',true,100001)).toThrow();
 expect(()=>bindLifecycleEmailConnection(s,'not-a-tenant',c.id,c.version,'operator',true,100001)).toThrow();
 bindLifecycleEmailConnection(s,tenant,c.id,c.version,'operator',true,100001);
 expect(s.active).toEqual(before);expect(s.revision).toBe(globalRevision);
 expect(Object.keys(s.lifecycleSenders![tenant]!)).toEqual(['noreply']);
 expect(publicLifecycleSenders(s,tenant)).toEqual([expect.objectContaining({profile:'noreply',from:'lifecycle@example.test',name:null,fallbackName:'OneHR',staleBindings:[],hasUnappliedChanges:false})]);
 expect(publicLifecycleSenders(s,'22222222-2222-4222-8222-222222222222').map(sender=>sender.from)).toEqual([config.from]);
 const bound=s.lifecycleSenders![tenant]!.noreply!,connection=s.connections![bound.connectionId];
 saveEmailConnection(s,{id:connection.id,name:connection.name,config:{...config,from:'new-lifecycle@example.test'},password:'fictional-new',revision:revision(s)});
 expect(bound.relay.config.from).toBe('lifecycle@example.test');expect(publicLifecycleSenders(s,tenant)[0]).toMatchObject({from:'lifecycle@example.test',hasUnappliedChanges:true});
 expect(JSON.stringify(publicLifecycleSenders(s,tenant))).not.toContain('fictional-');
 expect(()=>bindLifecycleEmailConnection(s,tenant,connection.id,connection.version,'operator',true,100001)).toThrow();
});

it('rejects a stale receipt after another administrator changes the sender binding',()=>{
 const s=state(),tenant='11111111-1111-4111-8111-111111111111';emailConnections(s);
 const a=saveEmailConnection(s,{name:'First',config,password:'fictional-first',revision:revision(s)}),b=saveEmailConnection(s,{name:'Second',config,password:'fictional-second',revision:revision(s)});
 for(const c of [a,b]){c.testedAt=100000;c.testedBy='operator';}
 bindLifecycleEmailConnection(s,tenant,a.id,a.version,'operator',true,100001);
 expect(()=>bindLifecycleEmailConnection(s,tenant,b.id,b.version,'operator',true,100001)).toThrow();expect(s.lifecycleSenders![tenant]!.noreply!.connectionId).toBe(a.id);
});

it('reports legacy version-marker reuse while retaining the actual confirmed sender snapshot',()=>{
 const s=state(),tenant='11111111-1111-4111-8111-111111111111';emailConnections(s);const c=s.connections!['current-relay'];c.testedAt=100000;c.testedBy='operator';c.testedAgainstRevision=s.revision;
 bindLifecycleEmailConnection(s,tenant,c.id,c.version,'operator',true,100001);
 s.connections!['current-relay']={...c,config:{...config,from:'changed-default@example.test'}};
 expect(publicLifecycleSenders(s,tenant)[0]).toMatchObject({from:config.from,hasUnappliedChanges:true});
});

describe('tenant On/Off Boarding sender name',()=>{
 const tenant='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
 const binding=(s:ConnectionState,name:string,from:string)=>{const c=saveEmailConnection(s,{name,config:{...config,from},password:'fictional-'+name,revision:revision(s)});c.testedAt=100000;c.testedBy='operator';return c;};
 it('stores a validated name for the session tenant only and resolves it at send time',()=>{
  const s=state();emailConnections(s);
  expect(nameLifecycleSender(s,tenant,'  Fictional Group HR  ','operator',5)).toBe('Fictional Group HR');
  expect(s.lifecycleSenderNames).toEqual({[tenant]:{name:'Fictional Group HR',setAt:5,setBy:'operator'}});
  expect(resolveLifecycleSender(s,tenant)).toMatchObject({senderName:'Fictional Group HR',relay:{config:{from:config.from}}});
  // Another tenant on the installation keeps the connection's own name.
  expect(resolveLifecycleSender(s,other)).toMatchObject({senderName:'OneHR'});
  expect(publicLifecycleSenders(s,tenant)[0]).toMatchObject({name:'Fictional Group HR',namedAt:new Date(5).toISOString()});
 });
 it.each(['','   ','Payroll <payroll@untrusted.invalid>','ceo@untrusted.invalid','Fictional "quoted"','Line\nBreak','x'.repeat(161)])('refuses the name %j',name=>{
  const s=state();expect(()=>nameLifecycleSender(s,tenant,name,'operator')).toThrow();expect(s.lifecycleSenderNames).toBeUndefined();
 });
 it('falls back to the bound connection name, then holds when a legacy per-name binding points elsewhere',()=>{
  const s=state();emailConnections(s);const surviving=binding(s,'Surviving','surviving@example.test');
  bindLifecycleEmailConnection(s,tenant,surviving.id,surviving.version,'operator',true,100001);
  expect(resolveLifecycleSender(s,tenant)).toMatchObject({senderName:'OneHR',relay:{config:{from:'surviving@example.test'}}});
  // An installation upgraded from three names may still carry an hr binding to a different mailbox.
  const legacy=binding(s,'Legacy','legacy@example.test');
  s.lifecycleSenders![tenant]!.hr={connectionId:legacy.id,version:legacy.version,relay:{config:legacy.config,password:legacy.password},revision:'r'.repeat(43),appliedAt:1,appliedBy:'operator'};
  expect(resolveLifecycleSender(s,tenant)).toBeNull();
  expect(publicLifecycleSenders(s,tenant)[0].staleBindings).toEqual(['hr']);
  // The same connection and version under an old key is not a conflict.
  s.lifecycleSenders![tenant]!.hr={...s.lifecycleSenders![tenant]!.noreply!};
  expect(resolveLifecycleSender(s,tenant)).not.toBeNull();expect(publicLifecycleSenders(s,tenant)[0].staleBindings).toEqual([]);
 });
 it('holds an upgraded tenant with only a legacy binding until it is re-applied, which retires the old keys',()=>{
  const s=state();emailConnections(s);const legacy=binding(s,'Legacy','legacy@example.test');
  s.lifecycleSenders={[tenant]:{onboarding:{connectionId:legacy.id,version:legacy.version,relay:{config:legacy.config,password:legacy.password},revision:'r'.repeat(43),appliedAt:1,appliedBy:'operator'}}};
  expect(resolveLifecycleSender(s,tenant)).toBeNull();expect(publicLifecycleSenders(s,tenant)[0].staleBindings).toEqual(['onboarding']);
  bindLifecycleEmailConnection(s,tenant,legacy.id,legacy.version,'operator',true,100001);
  expect(Object.keys(s.lifecycleSenders[tenant]!)).toEqual(['noreply']);expect(resolveLifecycleSender(s,tenant)).toMatchObject({relay:{config:{from:'legacy@example.test'}}});
 });
});
