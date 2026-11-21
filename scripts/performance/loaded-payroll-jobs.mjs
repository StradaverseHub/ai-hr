/** Publish elapsed phase boundaries from the hosted fictional receipt test. */
export function projectPayrollAdmissionPhases(log) {
  const phaseNames = ['session', 'translations', 'prechecks', 'enqueue'];
  const samples = [];
  for (const [, line] of log.matchAll(/^PERF_PAYROLL_RECEIPT (.{1,2200})$/gm)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!['steady-0', 'steady-1', 'preflight'].includes(entry?.sample) ||
        !['queued', 'refused', 'error'].includes(entry?.outcome) ||
        !Number.isSafeInteger(entry.handlerMs) || entry.handlerMs < 0 || entry.handlerMs > 180000) continue;
    const phases = Object.fromEntries(phaseNames.filter(name => entry.phases?.[name] !== undefined)
      .map(name => [name, entry.phases[name]]));
    const values = Object.values(phases);
    if (Object.keys(phases).some((name, index) => name !== phaseNames[index]) ||
        values.some((ms, index) => !Number.isSafeInteger(ms) || ms < (values[index - 1] ?? 0) || ms > entry.handlerMs) ||
        (entry.outcome === 'queued' && values.length !== phaseNames.length)) continue;
    const database = {};
    for (const phase of phaseNames) {
      for (const kind of ['raw', 'transaction']) {
        const row = entry.database?.[phase]?.[kind];
        if (!row) continue;
        const keys = ['started', 'acquired', 'completed', 'startDelayMs', 'afterStartMs'];
        if (!keys.every(key => Number.isSafeInteger(row[key]) && row[key] >= 0)
          || row.started < 1 || row.started > 128 || row.acquired > row.started || row.completed > row.acquired
          || row.startDelayMs > 300000 || row.afterStartMs > 300000) continue;
        (database[phase] ??= {})[kind] = Object.fromEntries(keys.map(key => [key, row[key]]));
      }
    }
    samples.push({ sample: entry.sample, outcome: entry.outcome, phases, handlerMs: entry.handlerMs,
      ...(Object.keys(database).length ? { database } : {}) });
    if (samples.length === 8) break;
  }
  return samples;
}

/** Publish only the synthetic tenant ordinal, bounded durations, and observed load. */
export function projectLoadedPayrollJobs(input) {
  if (!Array.isArray(input)) return null;
  const invalid = { state: 'invalid', jobs: [] };
  if (input.length > 2) return invalid;

  const timings = ['receiptHeadersMs', 'responseMs', 'acknowledgmentMs', 'verifiedCompletionMs', 'verifiedExportMs'];
  const witnesses = ['startedWith', 'verifiedWith', 'exportStartedWith', 'exportVerifiedWith'];
  const jobs = [];
  for (const row of input) {
    if (!row || ![0, 1].includes(row.tenant) || jobs.some(job => job.tenant === row.tenant)) return invalid;
    const job = { tenant: row.tenant };
    for (const field of timings) {
      const time = row[field];
      if (time === undefined) continue;
      if (!Number.isSafeInteger(time) || time < 0 || time > 600000) return invalid;
      job[field] = time;
    }
    for (const field of witnesses) {
      const load = row[field];
      if (load === undefined) continue;
      if (!load || !Number.isInteger(load.active) || !Number.isInteger(load.launched) ||
          load.active < 0 || load.active > load.launched || load.launched > 500 ||
          typeof load.inSteadyWindow !== 'boolean') return invalid;
      job[field] = { active: load.active, launched: load.launched, inSteadyWindow: load.inSteadyWindow };
    }
    if (!job.startedWith ||
        ((job.receiptHeadersMs !== undefined || row.receiptConfirmed !== undefined) &&
          !(row.receiptConfirmed === true && job.receiptHeadersMs <= job.responseMs)) ||
        (job.acknowledgmentMs !== undefined && !(job.responseMs <= job.acknowledgmentMs)) ||
        ((job.verifiedCompletionMs !== undefined || job.verifiedWith) &&
          !(job.verifiedWith && job.acknowledgmentMs <= job.verifiedCompletionMs)) ||
        (job.exportStartedWith && !job.verifiedWith) ||
        ((job.verifiedExportMs !== undefined || job.exportVerifiedWith) &&
          !(job.exportStartedWith && job.exportVerifiedWith && job.verifiedExportMs !== undefined))) return invalid;
    if (row.receiptConfirmed === true) job.receiptConfirmed = true;
    jobs.push(job);
  }
  jobs.sort((left, right) => left.tenant - right.tenant);
  const verifiedAtFullLoad = job => witnesses.every(field =>
    job[field]?.active === 500 && job[field].inSteadyWindow);
  return { state: jobs.length === 2 && jobs.every(verifiedAtFullLoad) ? 'verified-at-steady-load' : 'incomplete', jobs };
}

/** Publish the observed browser receipt and processed-register control without page text or identifiers. */
export function projectPayrollUiPreflight(input) {
  if (!input || !Number.isSafeInteger(input.browserReceiptMs) ||
      input.browserReceiptMs < 0 || input.browserReceiptMs > 90000) return null;
  const { browserReceiptMs, registerReadyMs } = input;
  if (registerReadyMs === undefined) return { browserReceiptMs };
  if (!Number.isSafeInteger(registerReadyMs) || registerReadyMs < browserReceiptMs ||
      registerReadyMs > 240000) return null;
  return { browserReceiptMs, registerReadyMs };
}

/** A snapshot after client traffic settled. It cannot establish in-window acknowledgement. */
export function projectPayrollAfterTraffic(input) {
  if (input?.status === 'unavailable') {
    const kind = ['Error', 'AssertionError', 'TimeoutError', 'AbortError', 'TypeError', 'AggregateError', 'unclassified'].includes(input.kind)
      ? input.kind : null;
    const sqlState = typeof input.sqlState === 'string' && /^[0-9A-Z]{5}$/.test(input.sqlState) ? input.sqlState : null;
    return { status: 'unavailable', rows: [], ...(kind && { kind }), ...(sqlState && { sqlState }) };
  }
  if (input?.status !== 'checked') return null;
  const invalid = { status: 'invalid', rows: [] };
  if (!Array.isArray(input.rows) || input.rows.length > 2) return invalid;

  const batchStates = new Set(['draft', 'processing', 'processed', 'closed']);
  const jobStates = new Set(['queued', 'preparing', 'running', 'finalizing', 'discarding', 'completed', 'failed', 'cancelled']);
  const count = value => Number.isInteger(value) && value >= 0 && value <= 1000;
  const rows = [];
  for (const row of input.rows) {
    if (!row) return invalid;
    const {tenant, batchState, jobCount, jobState, payslipCount} = row;
    if (![0, 1].includes(tenant) || rows.some(observed => observed.tenant === tenant) ||
        !(batchStates.has(batchState) || batchState === null) || !count(jobCount) || !count(payslipCount) ||
        (jobCount === 1 ? !jobStates.has(jobState) : jobState !== null)) return invalid;
    rows.push({tenant, batchState, jobCount, jobState, payslipCount});
  }
  return { status: 'checked', rows };
}

/** The action may return its redirect headers while the response stream is still open. */
export function projectTimedOutPayrollResponses(errors, loadStartedMs, tenantForActor) {
  if (!Array.isArray(errors) || !Number.isFinite(loadStartedMs)) return [];
  const attempts = [];
  for (const row of errors) {
    if (row?.action !== 'payrollProcess' || row.route !== '/payroll/[batchId]' ||
        row.role !== 'groupHR' || row.method !== 'POST' || row.error !== 'ABORT_ERR' ||
        !Number.isFinite(row.startedMs) || row.startedMs < loadStartedMs) continue;
    const tenant = tenantForActor.get(row.user);
    const headers = row.responseHeaders;
    const timing = value => Number.isFinite(value) && value >= 0 && value <= 180000;
    if (![0, 1].includes(tenant) || attempts.some(attempt => attempt.tenant === tenant) ||
        !timing(row.elapsedMs) || (headers && (!Number.isInteger(headers.status) ||
        headers.status < 100 || headers.status > 599 || !timing(headers.ttfbMs) ||
        headers.ttfbMs > row.elapsedMs ||
        !['queued', 'refused', 'unexpected', 'none'].includes(headers.payrollRedirect)))) return [];
    attempts.push({ tenant, elapsedMs: Math.round(row.elapsedMs), headers: headers ? {
      status: headers.status, elapsedMs: Math.round(headers.ttfbMs), redirect: headers.payrollRedirect,
    } : null });
  }
  return attempts.sort((left, right) => left.tenant - right.tenant);
}
