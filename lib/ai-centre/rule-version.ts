/** ADR-0170 §3.14: the approver sees which version of a rule a check ran under. Native owners return an
 * internal version reference (core/outcome-record/rule-versions.ts), for example
 * `leave_type:<uuid>@v3` or `leave_approval_chain:builtin@v1`. This turns one into what the screen may show:
 * the kind of rule and its version number, never the internal id. A reference it does not recognise shows
 * nothing, and no effective date is shown because none is published with the version.
 * Screen only: the version is classed `never` for the model provider and is not sent there. */
export type RuleVersionLabel = Readonly<{ kind: 'leave_type' | 'approval_chain'; version: number }>;

const PATTERN = /^(leave_type|leave_approval_chain):[^@\s]{1,80}@v(\d{1,6})$/;

export function ruleVersionLabel(reference: string | null | undefined): RuleVersionLabel | null {
  if (typeof reference !== 'string') return null;
  const match = PATTERN.exec(reference);
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return Object.freeze({ kind: match[1] === 'leave_type' ? 'leave_type' : 'approval_chain', version });
}
