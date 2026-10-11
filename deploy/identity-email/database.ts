import type postgres from 'postgres';
import type { IdentityEmailActor } from '../../lib/identity/email-model';

/** Use the driver's JSON parameter: a pre-stringified value becomes a JSON string with a raw client. */
export async function recordEmailAudit(database: postgres.Sql, actor: IdentityEmailActor, action: string, metadata: Record<string, postgres.JSONValue>) {
  await database`select identity_email.record_event(${actor.issuer},${actor.subject},${actor.userId}::uuid,${actor.tenantId}::uuid,${action},${database.json(metadata)}::jsonb)`;
}

/** Exact grants used by privileged installation and exercised with an actual isolated test role. */
export function emailServiceDatabaseGrants(database: string, role = 'aihr_identity_email'): string[] {
  const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  return [
    `GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(role)}`,
    `GRANT USAGE ON SCHEMA identity_email TO ${identifier(role)}`,
    `GRANT EXECUTE ON FUNCTION identity_email.operator_info(text,text,uuid,uuid),identity_email.record_event(text,text,uuid,uuid,text,jsonb) TO ${identifier(role)}`,
  ];
}

/** Added by the workflow-email upgrade; separate from the original installation's grants. */
export function workflowEmailDatabaseGrants(role='aihr_identity_email'):string[] {
  const quoted='"'+role.replaceAll('"','""')+'"';
  return [`GRANT EXECUTE ON FUNCTION identity_email.delivery_target(uuid,uuid,text),identity_email.start_delivery(uuid,uuid,text),identity_email.finish_delivery(uuid,uuid,text,text) TO ${quoted}`];
}
