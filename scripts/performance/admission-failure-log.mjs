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
