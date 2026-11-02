/** ADR-0169 phase B — minimized setup state for the Assistant context layer.
 *
 * Read-only composition of the native readiness owners (payroll configuration for one company and
 * employee-record gaps), run as the caller under tenant RLS. Administrators only. Minimum necessary by
 * construction: check keys, statuses, native counts and each check's own in-product link; never employee
 * names, codes or values. The readiness screens remain where people see who is affected. Not imported by
 * the production Assistant (outside the provider privacy closure until the ADR-0169 §5.1 review passes). */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {payrollReadiness,type ReadinessCheckKey,type ReadinessStatus} from '../../packs/payroll/service';
import {recordReadiness,type ReadinessGapId} from '../record-readiness';
import {moduleReadiness,type ModuleReadiness} from './module-readiness';

export type SetupReadiness=Readonly<{
 payroll:Readonly<{payPeriod:string;ready:boolean;blockers:number;warnings:number;
  checks:readonly Readonly<{key:ReadinessCheckKey;status:ReadinessStatus;detail:Readonly<Record<string,number>>;href:string}>[]}>|null;
 records:Readonly<{employees:number;ready:number;gaps:readonly Readonly<{id:ReadinessGapId;blocks:string;count:number}>[]}>|null;
 /** Leave (with public holidays), attendance and onboarding setup, each null when its module is off. */
 modules:ModuleReadiness;
}>;
export class SetupReadinessRefused extends Error{constructor(){super('Setup readiness is available to administrators only.');this.name='SetupReadinessRefused';}}

/** Payroll readiness for `companyId` this pay period, record gaps across the caller's scope, and leave,
 * attendance and onboarding setup for `companyId`. A source the caller cannot read resolves to null rather
 * than failing the whole summary. */
export async function setupReadiness(ctx:SessionContext,companyId:string):Promise<SetupReadiness>{
 if(!isAdmin(ctx))throw new SetupReadinessRefused();
 const [payroll,records,modules]=await Promise.all([
  payrollReadiness(ctx,{companyId}).catch(()=>null),
  // peopleLimit 0: names are never needed here; the native count is always the true total.
  recordReadiness(ctx,{peopleLimit:0}).catch(()=>null),
  moduleReadiness(ctx,companyId),
 ]);
 return Object.freeze({
  payroll:payroll&&Object.freeze({payPeriod:payroll.payPeriod,ready:payroll.ready,blockers:payroll.blockers,warnings:payroll.warnings,
   checks:Object.freeze(payroll.checks.map(check=>Object.freeze({key:check.key,status:check.status,detail:Object.freeze({...check.detail}),href:check.href})))}),
  records:records&&Object.freeze({employees:records.employees,ready:records.ready,
   gaps:Object.freeze(records.gaps.map(gap=>Object.freeze({id:gap.id,blocks:gap.blocks,count:gap.count})))}),
  modules,
 });
}
