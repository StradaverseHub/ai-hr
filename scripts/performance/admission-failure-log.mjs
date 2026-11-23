/** Closed diagnostic counters. Never return error text, SQL, parameters or identities. */
export function admissionFailureMarkers(log) {
  return {
    queueFull: [...log.matchAll(/\bcode:\s*['"]queue-full['"]/g)].length,
    queueTimeout: [...log.matchAll(/\bcode:\s*['"]queue-timeout['"]/g)].length,
    admissionError: [...log.matchAll(/DatabaseAdmissionError/g)].length,
    statementTimeout: [...log.matchAll(/canceling statement due to statement timeout/g)].length,
    lockTimeout: [...log.matchAll(/canceling statement due to lock timeout/g)].length,
    passiveReadUnavailable: [...log.matchAll(/Shared shell approval facts unavailable/g)].length,
  };
}

const stages = {
  shell: new Set(['session', 'idle-policy', 'principals', 'company-scope', 'viewer', 'navigation-access',
    'letters', 'onboarding-navigation', 'onboarding-tasks', 'lifecycle-navigation', 'lifecycle-inbox',
    'assistant', 'identity-email']),
  next: new Set(['render', 'action', 'route', 'proxy']),
};

export function admissionFailureOrigins(log) {
  const groups = new Map();
  for (const [, source, stage, kind] of log.matchAll(
    /^PERF_ADMISSION_FAILURE (shell|next) ([a-z-]{1,24}) (queue-full|queue-timeout|capacity-digest)$/gm,
  )) {
    if (!stages[source].has(stage)) continue;
    const key = source + ':' + stage + ':' + kind;
    const row = groups.get(key) ?? {source, stage, kind, count: 0};
    row.count++;
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
