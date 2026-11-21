/** Publish only the synthetic tenant ordinal, bounded durations, and observed load. */
export function projectLoadedPayrollJobs(input) {
  if (!Array.isArray(input)) return null;
  const invalid = { state: 'invalid', jobs: [] };
  if (input.length > 2) return invalid;

  const timings = ['responseMs', 'acknowledgmentMs', 'verifiedCompletionMs', 'verifiedExportMs'];
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
        (job.acknowledgmentMs !== undefined && !(job.responseMs <= job.acknowledgmentMs)) ||
        ((job.verifiedCompletionMs !== undefined || job.verifiedWith) &&
          !(job.verifiedWith && job.acknowledgmentMs <= job.verifiedCompletionMs)) ||
        (job.exportStartedWith && !job.verifiedWith) ||
        ((job.verifiedExportMs !== undefined || job.exportVerifiedWith) &&
          !(job.exportStartedWith && job.exportVerifiedWith && job.verifiedExportMs !== undefined))) return invalid;
    jobs.push(job);
  }
  jobs.sort((left, right) => left.tenant - right.tenant);
  const verifiedAtFullLoad = job => witnesses.every(field =>
    job[field]?.active === 500 && job[field].inSteadyWindow);
  return { state: jobs.length === 2 && jobs.every(verifiedAtFullLoad) ? 'verified-at-steady-load' : 'incomplete', jobs };
}
