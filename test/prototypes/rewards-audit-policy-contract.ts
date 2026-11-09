/** Hosted-generated canonical truth and exact reversible source boundaries; no DB imports. */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {chainArmingDecision} from '../../core/audit-chain-arming';
const source=readFileSync('test/prototypes/rewards-audited-read.sql','utf8');
if(createHash('sha256').update(source).digest('hex')!=='cad7076c1263888257084dbf5b2eef77ebb6e360dbf08ae38e2029a00a58b654')throw Error('Exact qualified315 prototype SQL required');
const closure: {functions:Array<{signature:string;body:string}>}=JSON.parse(readFileSync('test/prototypes/rewards-audit-policy-predecessors.json','utf8'));
function one(text:string,from:string,to:string){if(text.split(from).length!==2)throw Error('Exact single native replacement boundary required: '+from.slice(0,90));return text.replace(from,to);}
function baseBody(name:string){return source.slice(source.indexOf('CREATE FUNCTION '+name)).split('AS $body$')[1].split('$body$;')[0];}
export function rewardsAuditCanonicalTruthContract(){
 return ([-1,0,1]as const).flatMap(setting_code=>[false,true].flatMap(has_history=>[false,true].map(env_armed=>{
  const decision=chainArmingDecision({settingEnabled:setting_code===-1?null:setting_code===1,hasChainedHistory:has_history,envArmed:env_armed});
  return{setting_code,has_history,env_armed,armed:decision.armed,refused_disarm:decision.refusedDisarm,reason:decision.reason};
 })));
}
export function rewardsAuditPolicyReplacementBodies(){
 const next=closure.functions.find(row=>row.signature==='app._domain_event_next(uuid,boolean)');if(!next)throw Error('Canonical native audit owner absent');
 let nextBody=one(next.body,'v_prev_seq bigint;armed boolean;','v_prev_seq bigint;armed boolean;native_floor boolean;');
 nextBody=one(nextBody,' SELECT chain_seq,hash INTO v_prev_seq,v_prev_hash',' native_floor:=reward_audit_policy_private.floor_for_xact(p_tenant);\n SELECT chain_seq,hash INTO v_prev_seq,v_prev_hash');
 nextBody=one(nextBody,"AND value='true'::jsonb);","AND value='true'::jsonb) OR native_floor;");
 let begin=one(baseBody('reward_audit_read.begin_read'),'PERFORM reward_audit_private.assert_profile();','PERFORM reward_audit_policy_private.assert_profile();');
 begin=one(begin,' OR NOT EXISTS(SELECT 1 FROM public.domain_event WHERE tenant_id=app.current_tenant_id()AND chain_seq IS NOT NULL)\n','');
 begin=one(begin,' RETURN r;',' PERFORM reward_audit_policy_private.observe(r);\n RETURN r;');
 let finalize=one(baseBody('reward_audit_read.finalize_read'),'PERFORM reward_audit_private.assert_profile();','PERFORM reward_audit_policy_private.assert_profile();');
 finalize=one(finalize,' INSERT INTO reward_audit_private.receipt',' PERFORM reward_audit_policy_private.require_observation(p_admission);\n INSERT INTO reward_audit_private.receipt');
 finalize=one(finalize,' DELETE FROM reward_audit_private.admission', ' PERFORM reward_audit_policy_private.mark_receipt_floor(p_admission);\n DELETE FROM reward_audit_private.admission');
 let materialize=one(baseBody('reward_audit_projection.materialize'),'PERFORM reward_audit_private.assert_profile();','PERFORM reward_audit_policy_private.assert_profile();');
 materialize=one(materialize,"  IF r.version<>1 OR NOT EXISTS(SELECT 1 FROM public.domain_event WHERE tenant_id=r.tenant_id AND chain_seq IS NOT NULL)THEN RAISE EXCEPTION 'Supported armed-chain audit receipt required' USING ERRCODE='55000';END IF;", "  IF r.version<>1 OR NOT EXISTS(SELECT 1 FROM reward_audit_policy_private.observation o WHERE o.id=r.id AND o.tenant_id=r.tenant_id AND o.actor_id=r.actor_id AND o.observed_at=r.observed_at AND o.policy_version=1)THEN RAISE EXCEPTION 'Exact observed-policy audit receipt required' USING ERRCODE='55000';END IF;\n  PERFORM set_config('app.audit_hash_chain','off',true);\n  IF (reward_audit_policy_private.policy(r.tenant_id)->>'armed')::boolean THEN PERFORM set_config('app.audit_hash_chain','on',true);END IF;");
 materialize=one(materialize,'AND e.chain_seq IS NOT NULL AND e.hash=app.domain_event_hash(e.prev_hash,e.tenant_id,e.chain_seq,e.aggregate_type,e.aggregate_id,e.event_type,e.actor_type::text,e.actor_id,e.subject_employment_id,e.payload)',"AND app._domain_event_preimage_for(e)IS NOT NULL\n   AND(NOT(SELECT o.armed FROM reward_audit_policy_private.observation o WHERE o.id=r.id)OR e.chain_seq IS NOT NULL)");
 return new Map([['app._domain_event_next(uuid,boolean)',nextBody],['reward_audit_read.begin_read(text,text,integer)',begin],['reward_audit_read.finalize_read(uuid)',finalize],['reward_audit_projection.materialize(integer)',materialize]]);
}
