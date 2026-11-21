import { routingDigest } from '../../lib/ai/module-agent-routing';
import { PROTECTED_CATALOGUE_FORMAT } from './protected-catalogue-answer-format';
import { guidanceContractDigest, isGuidance, protectedStrategyDigest, type Guidance } from './protected-work-summary-guidance';

/** Reconstruct the optimizer's selected prefix from its frozen report. The report
 * is offline evidence whose custody stays with the evaluator. */
export function requireProtectedDevelopmentWinner(report: unknown, expected: {
  modelDigest: string;
  developmentCasesDigest: string;
  validationCasesDigest: string;
  validationCases: number;
  parentRules: readonly Guidance[];
  candidateRules: readonly Guidance[];
}) {
  const fail = (): never => { throw Error('The frozen development report does not select this candidate.'); };
  const row = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  };
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) &&
    value >= 0 && value <= expected.validationCases ? value : fail();
  const parsed = row(report);
  if (parsed.evidence !== 'offline_protected_selection_development' ||
      parsed.contractDigest !== guidanceContractDigest || parsed.modelDigest !== expected.modelDigest ||
      parsed.answerFormatDigest !== routingDigest(PROTECTED_CATALOGUE_FORMAT) ||
      parsed.developmentDigest !== expected.developmentCasesDigest || parsed.validationDigest !== expected.validationCasesDigest ||
      !Array.isArray(parsed.rounds) || parsed.rounds.length < 1 || parsed.rounds.length > 2) return fail();
  const baseline = row(parsed.baseline);
  const selected = row(parsed.selected);
  const accepted: Guidance[] = [];
  if (baseline.digest !== protectedStrategyDigest(accepted)) return fail();
  let correct = count(baseline.correct);
  let rejected = count(baseline.rejected);
  if (correct + rejected > expected.validationCases) return fail();
  for (const [index, value] of parsed.rounds.entries()) {
    const round = row(value);
    if (round.number !== index + 1 || round.parentDigest !== protectedStrategyDigest(accepted)) return fail();
    const terminal = index === parsed.rounds.length - 1;
    if (round.decision === 'no_valid_proposal') {
      if (!terminal || round.add !== undefined || round.candidateDigest !== undefined || round.validation !== undefined) return fail();
      break;
    }
    if (!isGuidance(round.add) || accepted.includes(round.add) ||
        round.candidateDigest !== protectedStrategyDigest([...accepted, round.add])) return fail();
    const validation = row(round.validation);
    const nextCorrect = count(validation.correct);
    const nextRejected = count(validation.rejected);
    const regressions = count(validation.regressions);
    if (nextCorrect + nextRejected > expected.validationCases || regressions > correct) return fail();
    const improved = nextCorrect > correct && nextRejected === 0 && regressions === 0;
    if (round.decision === 'retained_parent' && !improved && terminal) break;
    if (round.decision !== 'advanced_in_development' || !improved) return fail();
    accepted.push(round.add);
    correct = nextCorrect;
    rejected = nextRejected;
  }
  if (routingDigest(accepted) !== routingDigest(expected.candidateRules) ||
      routingDigest(accepted.slice(0, -1)) !== routingDigest(expected.parentRules) ||
      selected.digest !== protectedStrategyDigest(accepted) || routingDigest(selected.rules) !== routingDigest(accepted) ||
      selected.correct !== correct || selected.rejected !== rejected) return fail();
}
