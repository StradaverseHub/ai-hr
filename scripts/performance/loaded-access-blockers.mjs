/** Aggregate fixed diagnostic labels from the native Access lock samples. */
import { originalAdvisoryAttribution } from './lock-sample-attribution.mjs';

const modes = new Set(['ShareLock', 'ExclusiveLock']);
const blockerStates = new Set(['granted', 'queued']);
const backends = new Set(['web', 'worker', 'unclassified']);
const statements = new Set([
  'clocking import', 'attendance', 'leave', 'payroll', 'bulk job', 'personnel draft',
  'role assignment', 'access configuration', 'advisory lock', 'transaction end', 'unclassified',
]);
const isCount = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const edgeKey = edge => JSON.stringify([
  edge.waiterMode, edge.blockerMode, edge.blockerState, edge.backend, edge.statement,
]);
function describeBlocker(row) {
  return {
    backend: backends.has(row.access_backend) ? row.access_backend : 'unclassified',
    statement: statements.has(row.access_statement) ? row.access_statement : 'unclassified',
  };
}

export function createLoadedAccessBlockerDiagnostics() {
  const counts = new Map();
  let linkedSamples = 0;
  return {
    observe(locks, labels) {
      const { edges } = originalAdvisoryAttribution(locks, labels, describeBlocker);
      const matched = (edges ?? []).filter(edge => edge.family === 'access-configuration');
      if (!matched.length) return;
      linkedSamples++;
      for (const [key, edge] of new Map(matched.map(edge => [edgeKey(edge), edge]))) {
        const { waiterMode, blockerMode, blockerState, backend, statement } = edge;
        const row = counts.get(key) ?? { waiterMode, blockerMode, blockerState, backend, statement, samples: 0 };
        row.samples++;
        counts.set(key, row);
      }
    },
    facts() {
      return { linkedSamples, groups: [...counts.values()].sort((a, b) => b.samples - a.samples) };
    },
  };
}

/** A linked group can overlap another group in the same sample. Unknown samples stay visible. */
export function projectLoadedAccessBlockers(raw, accessSamples) {
  const maxGroups = 3 * blockerStates.size * backends.size * statements.size;
  if (!isCount(accessSamples, 4097) || !raw || !isCount(raw.linkedSamples, accessSamples)
    || !Array.isArray(raw.groups) || raw.groups.length > maxGroups
    || Boolean(raw.groups.length) !== Boolean(raw.linkedSamples)) return null;
  const groups = [];
  for (const row of raw.groups) {
    if (!row || !modes.has(row.waiterMode) || !modes.has(row.blockerMode) || !blockerStates.has(row.blockerState)
      || (row.waiterMode === 'ShareLock' && row.blockerMode === 'ShareLock')
      || !backends.has(row.backend) || !statements.has(row.statement)
      || !isCount(row.samples, raw.linkedSamples) || row.samples === 0) return null;
    const { waiterMode, blockerMode, blockerState, backend, statement, samples } = row;
    groups.push({ waiterMode, blockerMode, blockerState, backend, statement, samples });
  }
  if (new Set(groups.map(edgeKey)).size !== groups.length
    || groups.reduce((total, row) => total + row.samples, 0) < raw.linkedSamples) return null;
  return { linkedSamples: raw.linkedSamples, unlinkedSamples: accessSamples - raw.linkedSamples, groups };
}
