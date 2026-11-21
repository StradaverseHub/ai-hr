/** Reuse previously authored fictional questions and business labels verbatim. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ASSISTANT_CONVERSATION_HOLDOUTS} from '../../lib/ai/assistant-conversation-holdouts';
import {SPECIALIST_HOLDOUTS} from '../../lib/ai/module-specialist-holdouts';
import {SPECIALIST_FINDINGS, type SpecialistFinding} from '../../lib/ai/module-specialists';
import {localOutputPath, REPO_ROOT, writeLocalOutput} from '../teras/output';

export const HISTORICAL_EXPLANATION_SOURCE = 'e44710e6bccbb028f282022c05296ed836b99beb';
const authoredInputs = ['lib/ai/assistant-conversation-holdouts.ts', 'lib/ai/module-specialist-holdouts.ts'];
const exposedModules = new Set(['attendance', 'notifications', 'toil', 'claims', 'rewards']);
const generic = new Set<SpecialistFinding>([
  'scope_current_caller', 'empty_is_not_tenant_absence', 'bounded_results', 'withheld_not_reconstructable',
]);
const prefix = 'specialist_finding:';

export function historicalExplanationCases() {
  return ASSISTANT_CONVERSATION_HOLDOUTS.flatMap(row => {
    if (row.locale !== 'en' || row.category !== 'domain' || row.security || row.module === null ||
        exposedModules.has(row.module) || row.expected.mode !== 'answer') return [];
    const explanations = row.expected.blocks.filter(block => block.kind === 'explanation');
    if (explanations.length !== 1 || explanations[0].card !== null ||
        !explanations[0].code.startsWith(prefix)) return [];
    const expected = explanations[0].code.slice(prefix.length) as SpecialistFinding;
    if (!SPECIALIST_FINDINGS.includes(expected) || generic.has(expected)) return [];
    const choices = [...new Set(SPECIALIST_HOLDOUTS.filter(fixture => fixture.module === row.module)
      .flatMap(fixture => fixture.expected).filter(finding => !generic.has(finding)))].sort();
    if (choices.length < 2 || choices.length > 8 || !choices.includes(expected)) return [];
    return [{module: row.module, choices, focus: row.question, expected}];
  });
}

function writeCases(outfile: string, developmentReportPath: string) {
  const target = localOutputPath(outfile);
  if (existsSync(target)) throw Error('Use a new local case file.');
  for (const file of authoredInputs) {
    const historical = execFileSync('git', ['show', `${HISTORICAL_EXPLANATION_SOURCE}:${file}`],
      {cwd: REPO_ROOT, maxBuffer: 1024 ** 2});
    if (!historical.equals(readFileSync(join(REPO_ROOT, file)))) throw Error('Historical question or label source changed.');
  }
  const reportBytes = readFileSync(developmentReportPath);
  const report = JSON.parse(reportBytes.toString('utf8'));
  if (!/^[a-f0-9]{64}$/.test(report.modelDigest ?? '') || report.advanced !== true || report.revision !== 'include_source_focus')
    throw Error('Supply the winning model development report.');
  const cases = historicalExplanationCases();
  if (cases.length < 4 || cases.length > 32 || new Set(cases.map(row => row.module)).size !== cases.length)
    throw Error('Historical benchmark roster is incomplete or repeated.');
  const minimumGain = Math.max(2, Math.ceil(cases.length / 4));
  const spec = {version: 1, modelDigest: report.modelDigest,
    developmentReportDigest: createHash('sha256').update(reportBytes).digest('hex'), minimumGain, cases};
  writeLocalOutput(target, JSON.stringify(spec, null, 2));
  console.log(JSON.stringify({source: HISTORICAL_EXPLANATION_SOURCE, cases: cases.length, minimumGain,
    caseFileSha256: createHash('sha256').update(readFileSync(target)).digest('hex')}));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outfile, developmentReport, ...rest] = process.argv.slice(2);
  if (!outfile || !developmentReport || rest.length) throw Error('Supply a new case file and an exact development report.');
  writeCases(outfile, developmentReport);
}
