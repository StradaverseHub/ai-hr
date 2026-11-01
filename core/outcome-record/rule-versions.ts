/** ADR-0170 §3.11 and owner decision §3.14 — rule-version labels for every native check in an outcome record.
 *
 * Two kinds of rule, two version sources:
 *  - Company policy is versioned automatically on every admin edit. Entitlement tables already were
 *    (lineage + effective-dated version rows, core/entitlement-template.ts). Leave policy (the leave type's
 *    own rules) and approval chains (rules and reusable templates) carry `rule_version`, bumped by the
 *    database on every content change (migration 0891); no writer can skip or rewind it.
 *  - Statutory rules are versioned by us in the country pack: the label is the pack's own published version
 *    (or the tenant's dated override, or the built-in ruleset), resolved through the pack registry.
 *
 * The owners still decide: these functions only label the answer an owner already gave (an ApprovalDecision,
 * a ResolvedEntitlement, a leave type id) by reading that owner's version column in the caller's
 * transaction, under the caller's RLS. A label is an opaque, stable string for the record, never parsed. */
import {and,eq,gt,isNull,lte,or} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {entitlementEligibilityRule,entitlementTemplate} from '../../db/schema';
import {leaveApprovalPolicyRuleVersion as leaveApprovalPolicy,leaveApprovalTemplateRuleVersion as leaveApprovalTemplate,leaveTypeRuleVersion as leaveType} from '../../db/teras-schema';
import {requirePackFor} from '../../localization/registry';
import type {ApprovalDecision,ResolvedEntitlement} from '../../packs/leave/service';

export class RuleVersionUnavailable extends Error{constructor(readonly rule:string){super('Rule version unavailable: '+rule);this.name='RuleVersionUnavailable';}}

/** Leave policy: the leave type's eligibility, counting, document and carry rules. */
export async function leavePolicyVersionTx(tx:Tx,leaveTypeId:string):Promise<string>{
 const [row]=await tx.select({id:leaveType.id,ruleVersion:leaveType.ruleVersion}).from(leaveType).where(eq(leaveType.id,leaveTypeId)).limit(1);
 if(!row)throw new RuleVersionUnavailable('leave_type');
 return `leave_type:${row.id}@v${row.ruleVersion}`;
}

/** The built-in chain has no row; its version changes only with the code that defines it. */
export const BUILTIN_APPROVAL_CHAIN_VERSION='leave_approval_chain:builtin@v1';
/** Approval chain: the winning rule (and the template it draws its levels from), the tenant default
 * template, or the built-in chain, exactly as the owner's decision says. */
export async function approvalChainVersionTx(tx:Tx,decision:Pick<ApprovalDecision,'ruleId'|'source'>):Promise<string>{
 if(decision.source==='fallback')return BUILTIN_APPROVAL_CHAIN_VERSION;
 if(decision.source==='rule'){
  if(!decision.ruleId)throw new RuleVersionUnavailable('leave_approval_policy');
  const [rule]=await tx.select({id:leaveApprovalPolicy.id,ruleVersion:leaveApprovalPolicy.ruleVersion,templateId:leaveApprovalPolicy.templateId})
   .from(leaveApprovalPolicy).where(eq(leaveApprovalPolicy.id,decision.ruleId)).limit(1);
  if(!rule)throw new RuleVersionUnavailable('leave_approval_policy');
  const label=`leave_approval_policy:${rule.id}@v${rule.ruleVersion}`;
  if(!rule.templateId)return label;
  const [template]=await tx.select({id:leaveApprovalTemplate.id,ruleVersion:leaveApprovalTemplate.ruleVersion}).from(leaveApprovalTemplate)
   .where(eq(leaveApprovalTemplate.id,rule.templateId)).limit(1);
  if(!template)throw new RuleVersionUnavailable('leave_approval_template');
  return `${label}+leave_approval_template:${template.id}@v${template.ruleVersion}`;
 }
 const [template]=await tx.select({id:leaveApprovalTemplate.id,ruleVersion:leaveApprovalTemplate.ruleVersion}).from(leaveApprovalTemplate)
  .where(and(eq(leaveApprovalTemplate.isTenantDefault,true),eq(leaveApprovalTemplate.active,true))).limit(1);
 if(!template)throw new RuleVersionUnavailable('leave_approval_template');
 return `leave_approval_template:${template.id}@v${template.ruleVersion}`;
}

const inForce=(validFrom:typeof entitlementTemplate.validFrom,validTo:typeof entitlementTemplate.validTo,asOf:string)=>
 and(lte(validFrom,asOf),or(isNull(validTo),gt(validTo,asOf)));
/** Entitlement table: the existing lineage and the version row in force on the date the owner resolved for,
 * plus the eligibility rule that chose it when one did. */
export async function entitlementVersionTx(tx:Tx,resolved:Pick<ResolvedEntitlement,'templateLineageId'|'ruleLineageId'>,asOf:string):Promise<string>{
 const [table]=await tx.select({id:entitlementTemplate.id,validFrom:entitlementTemplate.validFrom}).from(entitlementTemplate)
  .where(and(eq(entitlementTemplate.lineageId,resolved.templateLineageId),inForce(entitlementTemplate.validFrom,entitlementTemplate.validTo,asOf))).limit(1);
 if(!table)throw new RuleVersionUnavailable('entitlement_template');
 const label=`entitlement_template:${resolved.templateLineageId}/${table.id}@${table.validFrom}`;
 if(!resolved.ruleLineageId)return label;
 const [rule]=await tx.select({id:entitlementEligibilityRule.id,validFrom:entitlementEligibilityRule.validFrom}).from(entitlementEligibilityRule)
  .where(and(eq(entitlementEligibilityRule.lineageId,resolved.ruleLineageId),inForce(entitlementEligibilityRule.validFrom,entitlementEligibilityRule.validTo,asOf))).limit(1);
 if(!rule)throw new RuleVersionUnavailable('entitlement_eligibility_rule');
 return `${label}+entitlement_eligibility_rule:${resolved.ruleLineageId}/${rule.id}@${rule.validFrom}`;
}

/** Statutory rules: the country pack's published version in force on `asOf`. A tenant override names its own
 * dated version; the built-in ruleset names the pack itself. */
export async function statutoryVersion(ctx:SessionContext,country:string,asOf:string):Promise<string>{
 const active=await requirePackFor(country).statutoryConfig.readActive(ctx,{asOf});
 const code=country.toUpperCase();
 if(active.source==='pack'){
  if(!active.packVersion)throw new RuleVersionUnavailable('statutory_pack');
  return `statutory:${code}:pack:${active.packVersion}@${active.effectiveFrom??'unknown'}`;
 }
 if(active.source==='override'){
  if(!active.row)throw new RuleVersionUnavailable('statutory_override');
  return `statutory:${code}:override:${active.row.version}@${active.row.effectiveFrom}`;
 }
 return `statutory:${code}:builtin@${active.effectiveFrom??'default'}`;
}
