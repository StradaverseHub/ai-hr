const markers = [
  ['principal_snapshot_current', /\bprincipal_snapshot_current\s*\(/i],
  ['current_grants', /\bcurrent_grants\s*\(/i],
  ['current_user_id', /\bcurrent_user_id\s*\(/i],
  ['login_blocked', /\blogin_blocked\s*\(/i],
  ['set_config', /\bset_config\s*\(/i],
  ['access_workforce_write_lock', /\baccess_workforce_write_lock\s*\(/i],
  ['advisory-lock', /\bpg_advisory_xact_lock(?:_shared)?\s*\(/i],
  ['app_user', /\b(?:from|join)\s+(?:public\.)?"?app_user\b/i],
  ['role_assignment', /\b(?:from|join)\s+(?:public\.)?"?role_assignment\b/i],
  ['employment', /\b(?:from|join)\s+(?:public\.)?"?employment\b/i],
  ['assignment', /\b(?:from|join)\s+(?:public\.)?"?assignment\b/i],
  ['claim_request', /\b(?:from|join)\s+(?:public\.)?"?claim_request\b/i],
  ['leave_request', /\b(?:from|join)\s+(?:public\.)?"?leave_request\b/i],
  ['domain_event', /\b(?:from|join)\s+(?:public\.)?"?domain_event\b/i],
];

function counter(value) {
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? number : null;
}

/** Retain bounded counters and fixed source markers from the disposable application-role snapshot. */
export function projectMixedRootStatementWork(statements) {
  if (!Array.isArray(statements) || statements.length > 35) return [];
  return statements.flatMap(statement => {
    if (typeof statement?.normalized_query !== 'string') return [];
    const calls = counter(statement.calls);
    const plans = counter(statement.plans);
    const planningMs = counter(statement.total_plan_time);
    const executionMs = counter(statement.total_exec_time);
    if ([calls, plans, planningMs, executionMs].some(value => value === null)) return [];
    return [{
      sourceMarkers: markers.filter(([, pattern]) => pattern.test(statement.normalized_query)).map(([name]) => name),
      calls, plans, planningMs: Math.round(planningMs), executionMs: Math.round(executionMs),
    }];
  }).sort((a, b) => (b.planningMs + b.executionMs) - (a.planningMs + a.executionMs)).slice(0, 12);
}
