const markers = [
  ['principal_snapshot_current', /\bprincipal_snapshot_current\s*\(/i],
  ['account-task-bundle', /\btask_caller\s+as\s+materialized\b/i],
  ['current_grants', /\bcurrent_grants\s*\(/i],
  ['current_user_id', /\bcurrent_user_id\s*\(/i],
  ['login_blocked', /\blogin_blocked\s*\(/i],
  ['set_config', /\bset_config\s*\(/i],
  ['access_workforce_write_lock', /\baccess_workforce_write_lock\s*\(/i],
  ['advisory-lock', /\bpg_advisory_xact_lock(?:_shared)?\s*\(/i],
  ['app_user', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?app_user\b/i],
  ['role_assignment', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?role_assignment\b/i],
  ['employment', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?employment\b/i],
  ['assignment', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?assignment\b/i],
  ['claim_request', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?claim_request\b/i],
  ['leave_request', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?leave_request\b/i],
  ['company', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?company\b/i],
  ['person', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?person\b/i],
  ['tenant_module', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?tenant_module\b/i],
  ['tenant_setting', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?tenant_setting\b/i],
  ['notification', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?notification\b/i],
  ['bulk_job', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?bulk_job\b/i],
  ['domain_event', /\b(?:from|join)\s+(?:(?:"public"|public)\.)?"?domain_event\b/i],
];

function counter(value) {
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= Number.MAX_SAFE_INTEGER
    ? number : null;
}

const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const kindPattern = /^\s*(select|with|insert|update|delete|merge|begin|commit|rollback|set|show)\b/i;
const appRoutine = /\b(?:app|"app")\s*\.\s*"?([a-z_][a-z0-9_]{0,62})"?\s*\(/gi;
const relation = /\b(?:from|join|update|into)\s+(?:(?:"(?:public|app)"|public|app)\s*\.\s*)?(?:"([a-z_][a-z0-9_]{0,62})"|([a-z_][a-z0-9_]{0,62})\b)(?!\s*\.)/gi;

function catalogSet(names) {
  return new Set(Array.isArray(names) && names.length <= 10000
    ? names.filter(name => typeof name === 'string' && identifier.test(name)) : []);
}

function references(query, pattern, catalog) {
  const found = new Set();
  for (const match of query.matchAll(pattern)) {
    const name = (match[1] ?? match[2]).toLowerCase();
    if (catalog.has(name)) found.add(name);
    if (found.size === 12) break;
  }
  return [...found];
}

function projectCatalogReferences(query, catalog) {
  const sqlShape = query.replace(/'(?:''|[^'])*'|\$([a-z_][a-z0-9_]*|)\$[\s\S]*?\$\1\$|\/\*[\s\S]*?\*\/|--[^\n]*/gi, ' ');
  return {
    statementKind: kindPattern.exec(sqlShape)?.[1].toLowerCase() ?? 'other',
    appRoutines: references(sqlShape, appRoutine, catalog.routines),
    relations: references(sqlShape, relation, catalog.relations),
  };
}

/** Retain counters and catalog-backed names without exporting any SQL text. */
export function projectMixedRootStatementWork(statements, nativeCatalog) {
  if (!Array.isArray(statements) || statements.length > 35) return [];
  const catalog = nativeCatalog && {
    routines: catalogSet(nativeCatalog.routines), relations: catalogSet(nativeCatalog.relations),
  };
  return statements.flatMap(statement => {
    if (typeof statement?.normalized_query !== 'string') return [];
    const calls = counter(statement.calls);
    const plans = counter(statement.plans);
    const planningMs = counter(statement.total_plan_time);
    const executionMs = counter(statement.total_exec_time);
    if ([calls, plans, planningMs, executionMs].some(value => value === null)) return [];
    return [{
      sourceMarkers: markers.filter(([, pattern]) => pattern.test(statement.normalized_query)).map(([name]) => name),
      ...(catalog && projectCatalogReferences(statement.normalized_query, catalog)),
      calls, plans, planningMs: Math.round(planningMs), executionMs: Math.round(executionMs),
    }];
  }).sort((a, b) => (b.planningMs + b.executionMs) - (a.planningMs + a.executionMs)).slice(0, 12);
}
