import {readFileSync} from 'node:fs';

const scenarios = JSON.parse(readFileSync(new URL('./navigation-scenarios.json', import.meta.url), 'utf8')).scenarios;
const scenarioRoles = new Map(scenarios.map(({id, role}) => [id, role]));
const linkCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000 ? value : null;

export function projectMixedNavigationPreflightFailure(fact) {
  if (!scenarioRoles.has(fact?.scenario) || scenarioRoles.get(fact.scenario) !== fact.role) return null;
  const total = linkCount(fact.linkMatches?.total);
  return {
    role: fact.role,
    scenario: fact.scenario,
    linkMatches: total === null ? null : {total, visible: linkCount(fact.linkMatches?.visible)},
  };
}

const payrollSurfaces = new Set(['resume','anomalies','draft-adjustments']);
const payrollRoles = new Set(['companyHR','groupHR']);
const payrollErrors = new Set(['TimeoutError','AssertionError','Error']);

export function projectMixedPayrollPreflight(facts) {
  if (!Array.isArray(facts)) return [];
  return facts.filter(fact => fact?.phase === 'baseline' &&
    payrollSurfaces.has(fact.surface) && payrollRoles.has(fact.role)).slice(0, 12).map(fact => ({
    role: fact.role,
    surface: fact.surface,
    outcome: fact.failed === true ? 'failed' :
      fact.scopeDenied === true ? 'scope-denied' : fact.usable === true ? 'usable-content' : 'unverified',
    elapsedMs: Number.isFinite(fact.elapsedMs) && fact.elapsedMs >= 0 && fact.elapsedMs <= 120000
      ? Math.round(fact.elapsedMs) : null,
    responseStatus: [200,404].includes(fact.status) ? fact.status : null,
    errorType: payrollErrors.has(fact.errorType) ? fact.errorType : null,
  }));
}

// Project only the location of the primary failure from the private inspect output.
// Paths, exception messages, and all secondary failures stay in the runner's private directory.
const frame = /^\s+at (?:[^\r\n(]+ \()?(?:file:\/\/)?[^\s()]*\/scripts\/performance\/(system-load-owner\.mjs|mixed-workflows\.mjs|navigation-browser-capture\.ts|navigation-shell-browser\.ts|org-explorer-browser\.mjs|home-http\.mjs|today-browser-readiness\.mjs|payroll-browser\.mjs|personnel-switcher-browser\.mjs):(\d{1,6}):(\d{1,5})\)?$/m;

export function mixedDriverPrimaryOrigin(inspection) {
  const { index: start } = /^  primary: \{/m.exec(inspection) ?? {};
  if (start === undefined) return null;
  const end = inspection.indexOf('\n  secondary:', start);
  const primary = inspection.slice(start, end === -1 ? undefined : end);
  const match = frame.exec(primary);
  if (!match) return null;
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}
