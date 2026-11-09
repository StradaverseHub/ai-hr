/** Pure definition/source controls only; none is native acceptance. */
import {expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {rewardsAuditCanonicalTruthContract,rewardsAuditPolicyReplacementBodies} from './prototypes/rewards-audit-policy-contract';
it('derives all12 rows from canonical owner and independently preserves every boolean/null/history/fallback outcome',()=>{
 const rows=rewardsAuditCanonicalTruthContract();expect(rows).toHaveLength(12);expect(new Set(rows.map(r=>[r.setting_code,r.has_history,r.env_armed].join(':'))).size).toBe(12);
 for(const row of rows){const effective=row.setting_code===1||row.has_history||row.setting_code===-1&&row.env_armed;
  expect(row.armed).toBe(effective);expect(row.refused_disarm).toBe(row.has_history&&(row.setting_code===0||row.setting_code===-1&&!row.env_armed));expect(row.reason.length).toBeGreaterThan(20);
 }
});
it('changes only the explicit four native bodies, retaining fresh canonical head/GUC/setting and private first-floor observation',()=>{
 const map=rewardsAuditPolicyReplacementBodies();expect([...map.keys()]).toEqual(['app._domain_event_next(uuid,boolean)','reward_audit_read.begin_read(text,text,integer)','reward_audit_read.finalize_read(uuid)','reward_audit_projection.materialize(integer)']);
 const body=map.get('app._domain_event_next(uuid,boolean)')!;
 const canonical=body.replace('v_prev_seq bigint;armed boolean;native_floor boolean;','v_prev_seq bigint;armed boolean;')
  .replace(' native_floor:=reward_audit_policy_private.floor_for_xact(p_tenant);\n','')
  .replace("AND value='true'::jsonb) OR native_floor;","AND value='true'::jsonb);");
 expect(createHash('md5').update(canonical).digest('hex')).toBe('e045132f89b378e39a8ecebce70da078');
 expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(body.indexOf('native_floor:='));expect(body.indexOf('native_floor:=')).toBeLessThan(body.indexOf('SELECT chain_seq,hash'));
 expect(body).toContain("current_setting('app.audit_hash_chain',true) IS NOT DISTINCT FROM 'on' OR v_prev_seq IS NOT NULL");
});
it('keeps SQL guard/private frame/receipt ownership closed without claiming fixture fallback is installed configuration',()=>{
 const sql=readFileSync('test/prototypes/rewards-audit-policy.sql','utf8');
 expect(sql).toContain("_domain_event_next(uuid,boolean)','e045132f89b378e39a8ecebce70da078'");
 expect(sql).toContain("domain_event_chain_tg()','67c5ccec77df9b5690b086c206d0166a'");
 expect(sql).toContain("_bank_audit_owner_frame_guard()','f70f12b5a66a6a99a5f01a266b591a30'");
 expect(sql).toContain("_assistant_catalogue_audit_owner_frame_guard()','c567cb10896020af14486b31d72b539c'");
 expect(sql).toContain('PRIMARY KEY(tenant_id,root_xid)');expect(sql).toContain('root_xid<>pg_current_xact_id()');expect(sql).toContain('FOR UPDATE SKIP LOCKED LIMIT p_limit');
 expect(sql).not.toMatch(/pg_temp\.floor_frame|FOREIGN KEY/);
 expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reward_audit_policy_private.require_marker_receipt()');
 const probe=sql.slice(sql.indexOf('CREATE FUNCTION reward_audit_policy_private.snapshot_floor('),sql.indexOf('CREATE FUNCTION reward_audit_policy_private.cleanup_frames('));
 expect(probe).toContain('SET CONSTRAINTS reward_audit_policy_private.reward_audit_policy_marker_complete DEFERRED');
 expect(probe).toContain('ON CONFLICT(tenant_id)DO NOTHING');expect(probe).toContain("EXCEPTION WHEN SQLSTATE 'ZXF01' THEN");
 expect(probe).not.toMatch(/WHEN OTHERS|WHEN serialization_failure|WHEN SQLSTATE '40001'/);
 expect(rewardsAuditPolicyReplacementBodies().get('reward_audit_read.finalize_read(uuid)')).toContain('mark_receipt_floor(p_admission);');
 expect(sql.match(/^GRANT .*$/gm)).toEqual(['GRANT EXECUTE ON FUNCTION reward_audit_read.reconcile_receipt(uuid)TO ai_hr_reward_audit_read;']);
});

it('the optional fixed startup keeps legacy omission exact and refuses every other supplied duration',async()=>{
 const {rewardsAuditPrototypeStartup:startup}=await import('./prototypes/rewards-audit-startup');
 expect(startup(undefined)).toEqual({});expect(startup(2)).toEqual({connect_timeout:2});
 expect(Object.isFrozen(startup(2))).toBe(true);
 for(const value of [null,0,1,3,30,2.1,'2',true,{},NaN,Infinity])expect(()=>startup(value)).toThrow();
});
