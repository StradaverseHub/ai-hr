/** Scoped Contract configuration over the existing shared groups and native Access identities. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {ContractManagementError} from '../lib/contract-management-model';
import {CONTRACT_CASE_PERMISSIONS, DEFAULT_CONTRACT_FLOW_SETTINGS, validateContractFlowSettings, type ContractFlowSettings} from '../lib/contract-case-flow';
import {pgSqlState} from '../lib/db-error';

const permission = z.enum(CONTRACT_CASE_PERMISSIONS);
const settingsSchema = z.object({
  fallbackGroupId: z.string().trim().min(1).max(200), postingApproverGroupId: z.string().trim().min(1).max(200),
  stallEnabled: z.boolean(), stallDays: z.number().int().min(1).max(60),
  automaticSuperior: z.object({enabled: z.boolean(), permissions: z.array(permission).max(5)}).strict(),
}).strict();
function refused(error: unknown): never {
  const state = pgSqlState(error);
  if (state === '42501') throw new ContractManagementError('forbidden', 'Contract configuration is unavailable.');
  if (state === '40001') throw new ContractManagementError('conflict', 'This changed since you opened it. Reload before saving.');
  if (state === '22023' || state === '23514' || state === '23505') throw new ContractManagementError('invalid', 'Check the name, scope, dates and group references before saving.');
  throw error;
}
export type ContractAccessRole = {id: string; name: string; permissions: (typeof CONTRACT_CASE_PERMISSIONS)[number][]; revision: number};
export type ContractAccessMember = {id: string; roleId: string; userId: string; name: string; companyId: string | null; businessUnitId: string | null; validFrom: string; validTo: string | null; revokedAt: string | null;revision:number};
export function contractSharedSettings(ctx: SessionContext, companyId: string): Promise<{revision: number; settings: ContractFlowSettings; accessAdmin: boolean}> {
  z.uuid().parse(companyId);
  return withScopedLifecycleTenant(ctx, async tx => {
    const [allowed] = await tx.execute<{ok: boolean; accessAdmin: boolean}>(sql`select app.contract_shared_permitted('access',${companyId}::uuid) as ok,app.contract_shared_access_admin() as "accessAdmin"`);
    if (!allowed?.ok) throw new ContractManagementError('forbidden', 'Contract settings are unavailable.');
    const [row] = await tx.execute<{revision: number; fallbackGroupId: string; postingApproverGroupId: string; stallEnabled: boolean; stallDays: number; superiorEnabled: boolean; superiorPermissions: ContractFlowSettings['automaticSuperior']['permissions']}>(sql`
      select revision,fallback_group_id as "fallbackGroupId",posting_group_id as "postingApproverGroupId",stall_enabled as "stallEnabled",stall_days as "stallDays",superior_enabled as "superiorEnabled",superior_permissions as "superiorPermissions"
      from contract_shared_settings where tenant_id=app.current_tenant_id() and company_id=${companyId}::uuid`);
    return {revision: row?.revision ?? 0, accessAdmin: allowed.accessAdmin,
      settings: row ? {fallbackGroupId: row.fallbackGroupId, postingApproverGroupId: row.postingApproverGroupId, stallEnabled: row.stallEnabled, stallDays: row.stallDays, automaticSuperior: {enabled: row.superiorEnabled, permissions: row.superiorPermissions}} : structuredClone(DEFAULT_CONTRACT_FLOW_SETTINGS)};
  });
}
export async function saveContractSharedSettings(ctx: SessionContext, raw: unknown): Promise<{revision: number}> {
  const input = z.object({companyId: z.uuid(), expectedRevision: z.number().int().min(0), settings: settingsSchema}).strict().parse(raw);
  validateContractFlowSettings(input.settings);
  try {
    return await withScopedLifecycleTenant(ctx, async tx => {
      const [row] = await tx.execute<{revision: number}>(sql`select app.contract_shared_settings_save(${input.companyId}::uuid,${input.expectedRevision},${JSON.stringify(input.settings)}::jsonb) as revision`);
      return row;
    });
  } catch (error) {return refused(error);}
}
export function contractSharedAccess(ctx: SessionContext): Promise<{roles: ContractAccessRole[]; members: ContractAccessMember[]}> {
  return withScopedLifecycleTenant(ctx, async tx => {
    const [allowed] = await tx.execute<{ok: boolean}>(sql`select app.contract_shared_access_admin() as ok`);
    if (!allowed?.ok) throw new ContractManagementError('forbidden', 'Contract access administration is unavailable.');
    const roles = await tx.execute<ContractAccessRole>(sql`select id,name,permissions,revision from contract_access_role where tenant_id=app.current_tenant_id() order by lower(name),id limit 200`);
    const members = await tx.execute<ContractAccessMember>(sql`select m.id,m.revision,m.role_id as "roleId",m.user_id as "userId",p.full_name as name,m.company_id as "companyId",m.business_unit_id as "businessUnitId",m.valid_from::text as "validFrom",m.valid_to::text as "validTo",m.revoked_at::text as "revokedAt" from contract_access_member m join app_user u on u.tenant_id=m.tenant_id and u.id=m.user_id join person p on p.tenant_id=u.tenant_id and p.id=u.person_id where m.tenant_id=app.current_tenant_id() order by p.full_name,m.id limit 1000`);
    return {roles: [...roles], members: [...members]};
  });
}
export async function saveContractSharedRole(ctx: SessionContext, raw: unknown): Promise<{revision: number}> {
  const input = z.object({id: z.uuid(), name: z.string().trim().min(1).max(120), permissions: z.array(permission).max(7), expectedRevision: z.number().int().min(0)}).strict().parse(raw);
  try {return await withScopedLifecycleTenant(ctx, async tx => {
    const [row] = await tx.execute<{revision: number}>(sql`select app.contract_shared_role_save(${input.id}::uuid,${input.name},${`{${input.permissions.join(',')}}`}::text[],${input.expectedRevision}) as revision`);
    return row;
  });} catch (error) {return refused(error);}
}
export async function saveContractSharedMember(ctx: SessionContext, raw: unknown): Promise<{id: string}> {
  const input = z.object({id: z.uuid(), roleId: z.uuid(), userId: z.uuid(), companyId: z.uuid().nullable(), businessUnitId: z.uuid().nullable(), validFrom: z.iso.date(), validTo: z.iso.date().nullable(), revoked: z.boolean(),expectedRevision:z.number().int().min(0).default(0)}).strict().parse(raw);
  if (input.validTo && input.validTo < input.validFrom) throw new ContractManagementError('invalid', 'Valid to must not precede Valid from.');
  try {return await withScopedLifecycleTenant(ctx, async tx => {
    const [row] = await tx.execute<{id: string}>(sql`select app.contract_shared_member_save(${input.id}::uuid,${input.roleId}::uuid,${input.userId}::uuid,${input.companyId}::uuid,${input.businessUnitId}::uuid,${input.validFrom}::date,${input.validTo}::date,${input.revoked},${input.expectedRevision}) as id`);
    return row;
  });} catch (error) {return refused(error);}
}
