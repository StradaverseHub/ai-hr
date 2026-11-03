/** AI v2 Phase 2, P2-6 — an approved eval candidate as the file a developer adds to test/assistant-smart-eval-set.ts.
 * Pure: no database, no clock, no model.
 *
 * The candidate's question and expectation were redacted when they were saved (./redact.ts) and an administrator read and
 * approved that text. Leaving the tenant, every placeholder becomes a fictional value (./redact.ts fictionalise), so the
 * file holds no name, id or figure of the tenant's. It is one SmartEvalConversation entry
 * (core/improvement/smart-eval-score.ts), commented with what a developer still has to do: check the turn against the
 * evaluation's own fixture facts, set `ideal` facts the fixture supports, and give it a unique id. Nothing adds it to the
 * set or changes a prompt: a developer reviews it and commits it like any other turn. The tenant, company, person and
 * record ids are never written; the candidate's own id appears only as a short opaque suffix, so a second export of the
 * same candidate gives the same entry id. */
import {fictionalise,PLACEHOLDER} from './redact';
import type {EvalFactor,EvalKind,LearningLocale,LearningRole} from './types';

export type ExportableCandidate=Readonly<{id:string;role:LearningRole;locale:LearningLocale;kind:EvalKind;factor:EvalFactor;question:string;expectation:string;
 approvedOn:string;origin:'signal'|'gap';signalKind?:string|null;intentKey?:string|null}>;

/** The eval set's locales today (core/improvement/smart-eval-score.ts SmartEvalLocale). */
const EVAL_LOCALES:readonly LearningLocale[]=['en','ms','zh'];
const literal=(value:string)=>`'${value.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\r?\n/g,' ')}'`;

export function candidateFileName(candidate:Pick<ExportableCandidate,'id'>):string{
 return `eval-candidate-${candidate.id.replace(/-/g,'').slice(0,12)}.ts`;
}

export function exportCandidate(candidate:ExportableCandidate):string{
 const suffix=candidate.id.replace(/-/g,'').slice(0,8);
 const id=`cand-${candidate.role.replace(/_/g,'-')}-${suffix}`;
 const question=fictionalise(candidate.question),ideal=fictionalise(candidate.expectation);
 const fictional=[...new Set([...candidate.question.matchAll(PLACEHOLDER),...candidate.expectation.matchAll(PLACEHOLDER)].map(match=>match[1]))].sort();
 const localeNote=EVAL_LOCALES.includes(candidate.locale)?null
  :`// The eval set does not take '${candidate.locale}' yet: extend SmartEvalLocale (core/improvement/smart-eval-score.ts) before adding this turn.`;
 const origin=candidate.origin==='gap'?`gap ${candidate.intentKey??''}`.trim():`signal ${candidate.signalKind??''}`.trim();
 return [
  '// AI Centre eval candidate: redacted, fictionalised and approved by a tenant administrator on '+candidate.approvedOn+'.',
  '// Add it to the right role\'s conversations in test/assistant-smart-eval-set.ts after checking it against the fixture facts',
  '// there. It was not added to the set, and no prompt was changed: that is a developer\'s review.',
  `// From: ${origin}.`,
  ...(fictional.length?[`// Fictional values replaced the tenant's ${fictional.map(kind=>kind.toLowerCase()).join(', ')}: set the fixture facts to match, or edit them.`]:[]),
  ...(localeNote?[localeNote]:[]),
  `{id:${literal(id)},role:${literal(candidate.role)},turns:[{id:${literal(id+'-1')},question:${literal(question)},locale:${literal(candidate.locale)},`,
  ` kind:${literal(candidate.kind)},factor:${literal(candidate.factor)},`,
  ` source:{kind:'reconstructed',issues:[],from:${literal('Tenant eval candidate, approved '+candidate.approvedOn+' ('+origin+').')}},`,
  ` ideal:${literal(ideal)}}]},`,
  '',
 ].join('\n');
}
