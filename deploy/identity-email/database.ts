/** Exact grants used by privileged installation and exercised with an actual isolated test role. */
export function emailServiceDatabaseGrants(database: string, role = 'aihr_identity_email'): string[] {
  const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  return [
    `GRANT CONNECT ON DATABASE ${identifier(database)} TO ${identifier(role)}`,
    `GRANT USAGE ON SCHEMA identity_email TO ${identifier(role)}`,
    `GRANT EXECUTE ON FUNCTION identity_email.operator_info(text,text,uuid,uuid),identity_email.record_event(text,text,uuid,uuid,text,jsonb) TO ${identifier(role)}`,
  ];
}
