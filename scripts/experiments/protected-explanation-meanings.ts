import { routingDigest } from '../../lib/ai/module-agent-routing';
import en from '../../messages/en.json';
import ms from '../../messages/ms.json';
import type { PilotModel } from '../teras/leave-improvement';
import { choose, observeModel } from './protected-explanation-priority';
import { historicalExplanationCases } from './write-historical-explanation-cases';

const prefix = 'specialist_finding:';
const languages = ['en', 'ms'] as const;
const findings: Readonly<Record<typeof languages[number], Readonly<Record<string, string>>>> = {
  en: en.assistant.workspace.specialistFindings,
  ms: ms.assistant.workspace.specialistFindings,
};
const minimumGain = 2;

/** Public development benchmark. Only the candidate receives static catalogue descriptions.
 * The evaluator scores the same choices in the same order in all three arms. */
export async function compareProtectedExplanationMeanings(model: PilotModel) {
  const prepared = languages.map(locale => {
    const cases = historicalExplanationCases(locale);
    if (cases.length < 4 || cases.length > 32) throw Error('Invalid public explanation benchmark roster.');
    const fixtures = cases.map(({ module, choices, focus, expected }) => {
      const meanings = Object.fromEntries(choices.map(code => {
        const description = findings[locale][code];
        if (!description || /[{}<>]/.test(description)) throw Error('Expected a static canonical explanation.');
        return [`${prefix}${code}`, description];
      }));
      return { fixture: {module, choices: choices.map(code => `specialist_finding:${code}` as const),
        focus, expected: `specialist_finding:${expected}` as const}, meanings };
    });
    return {locale, fixtures, caseDigest: routingDigest(cases)};
  });

  const { call, budget } = observeModel(model);
  const locales = [];
  for (const {locale, fixtures, caseDigest} of prepared) {
    const original = {correct: 0, rejected: 0, gains: 0, regressions: 0};
    const focused = {correct: 0, rejected: 0, gains: 0, regressions: 0};
    const meanings = {correct: 0, rejected: 0};
    const tokens = {original: {input: 0, output: 0}, focused: {input: 0, output: 0}, meanings: {input: 0, output: 0}};
    const measured = (arm: keyof typeof tokens): PilotModel => async request => {
      const response = await call(request);
      tokens[arm].input += response.inputTokens;
      tokens[arm].output += response.outputTokens;
      return response;
    };
    const chooseOriginal = measured('original'), chooseFocused = measured('focused'), chooseWithMeanings = measured('meanings');
    for (const row of fixtures) {
      const baseline = await choose(chooseOriginal, row.fixture, false);
      const parent = await choose(chooseFocused, row.fixture, true);
      const candidate = await choose(chooseWithMeanings, row.fixture, true, undefined, row.meanings);
      if (candidate !== 'incorrect') meanings[candidate]++;
      for (const [reference, outcome] of [[original, baseline], [focused, parent]] as const) {
        if (outcome !== 'incorrect') reference[outcome]++;
        if (outcome !== 'correct' && candidate === 'correct') reference.gains++;
        if (outcome === 'correct' && candidate !== 'correct') reference.regressions++;
      }
    }
    const passes = meanings.rejected === 0 && [original, focused].every(
      comparison => comparison.gains >= minimumGain && comparison.regressions === 0);
    locales.push({locale, cases: fixtures.length, caseDigest,
      meaningsDigest: routingDigest(fixtures.map(row => row.meanings)), original, focused, meanings, tokens, passes});
  }
  return {evidence: 'offline_explanation_meanings_development', releaseAuthorized: false,
    minimumGain, passes: locales.every(locale => locale.passes), locales, budget};
}
