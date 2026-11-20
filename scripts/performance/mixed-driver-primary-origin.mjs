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
