/**
 * 1d58019a Step 2 (ADR-0166) — Field Controls for a comparison event type, as PURE data and rules.
 *
 * Shared by the settings grid, the New Event form, the server writer and the import, so the screen and the
 * service evaluate one rule. No database import: the client form and the settings island load this module.
 *
 * THE FOUR CONTROLS, per field (the Employee Change Requests grid's shape):
 *   • included   — "Want to Change This". An excluded field is not shown and may not change.
 *   • editable   — "Allow to Edit". An included, non-editable field is shown read-only and may not change.
 *   • mustChange — "Required to Change". The after value must differ from the employee's current value.
 *   • document   — "File Enabled": none / optional / required. A required document is needed when the
 *                  movement actually changes that field (a document supports a change; demanding one for
 *                  a value that stays as it is would be paperwork about nothing).
 *
 * NO RULES MEANS TODAY. A type with no stored rules gets every comparison field included and editable,
 * none required to change, no document — exactly the form and the writer before this item. A type WITH
 * rules but missing a field (a field added to the product later) gets the same default for that field.
 *
 * ENTITY TRANSFER'S COMPANY IS LOCKED included, editable and required to change: moving the legal entity is
 * what that event type IS. The grid shows it fixed and the normaliser below overrides any stored value.
 */
import { MOVEMENT_FLAT_FIELDS } from './movement-pending-input';

export const MOVEMENT_RULE_FIELDS = [
  'companyId',
  'businessUnitId',
  'departmentId',
  'positionId',
  'gradeId',
  'employmentType',
  'locationId',
  'managerEmploymentId',
  ...MOVEMENT_FLAT_FIELDS,
  'basicSalary',
  'currency',
  'payMode',
  'paymentTerm',
] as const;
export type MovementRuleField = (typeof MOVEMENT_RULE_FIELDS)[number];
export const isMovementRuleField = (v: string): v is MovementRuleField =>
  (MOVEMENT_RULE_FIELDS as readonly string[]).includes(v);

/** The pay fields. Their documents follow the same access rule as the salary itself (migration 0722). */
export const MOVEMENT_PAY_FIELDS: readonly MovementRuleField[] = ['basicSalary', 'currency', 'payMode', 'paymentTerm'];

export const MOVEMENT_DOCUMENT_MODES = ['none', 'optional', 'required'] as const;
export type MovementDocumentMode = (typeof MOVEMENT_DOCUMENT_MODES)[number];
export const isMovementDocumentMode = (v: string): v is MovementDocumentMode =>
  (MOVEMENT_DOCUMENT_MODES as readonly string[]).includes(v);

export type MovementFieldRule = {
  field: MovementRuleField;
  included: boolean;
  editable: boolean;
  mustChange: boolean;
  document: MovementDocumentMode;
};

/** The grid's three groups, in the order the settings page and the New Event form draw them. */
export const MOVEMENT_RULE_GROUPS: readonly { id: 'organisation' | 'labels' | 'salary'; fields: readonly MovementRuleField[] }[] = [
  {
    id: 'organisation',
    fields: ['companyId', 'businessUnitId', 'departmentId', 'positionId', 'gradeId', 'employmentType', 'locationId', 'managerEmploymentId'],
  },
  { id: 'labels', fields: [...MOVEMENT_FLAT_FIELDS] },
  { id: 'salary', fields: ['basicSalary', 'currency', 'payMode', 'paymentTerm'] },
];

/** The fields a behaviour's grid offers. Company is part of Entity Transfer only; every other comparison
 *  type shows it as a read-only note and its writer ignores a submitted company. */
export function movementRuleFieldsFor(behaviour: string): MovementRuleField[] {
  return MOVEMENT_RULE_FIELDS.filter((f) => f !== 'companyId' || behaviour === 'entityTransfer');
}

export const defaultMovementFieldRule = (field: MovementRuleField): MovementFieldRule => ({
  field,
  included: true,
  editable: true,
  mustChange: false,
  document: 'none',
});

/**
 * Make one stored or submitted rule consistent: the dependencies the table's CHECKs encode are applied
 * (not editable ⇒ not required to change and no document; not included ⇒ none of the others), and Entity
 * Transfer's company is forced to included, editable and required to change.
 */
export function normaliseMovementFieldRule(behaviour: string, rule: MovementFieldRule): MovementFieldRule {
  if (behaviour === 'entityTransfer' && rule.field === 'companyId') {
    return { field: 'companyId', included: true, editable: true, mustChange: true, document: rule.document };
  }
  const included = rule.included;
  const editable = included && rule.editable;
  return {
    field: rule.field,
    included,
    editable,
    mustChange: editable && rule.mustChange,
    document: editable ? rule.document : 'none',
  };
}

/**
 * The effective rule for every field a behaviour's grid offers, given what is stored (possibly nothing).
 * `configured` is true when the type has at least one stored rule.
 */
export function effectiveMovementFieldRules(
  behaviour: string,
  stored: readonly MovementFieldRule[],
): { configured: boolean; rules: MovementFieldRule[] } {
  const byField = new Map(stored.map((r) => [r.field, r]));
  return {
    configured: stored.length > 0,
    rules: movementRuleFieldsFor(behaviour).map((field) =>
      normaliseMovementFieldRule(behaviour, byField.get(field) ?? defaultMovementFieldRule(field)),
    ),
  };
}

/** Why a movement does not meet its type's Field Controls. `field` is the offending comparison field. */
export type MovementFieldRuleViolation = {
  code: 'field_not_included' | 'field_not_editable' | 'field_must_change' | 'document_required' | 'document_not_enabled';
  field: MovementRuleField;
};

/**
 * The single rule check. `changed` is the set of comparison fields the movement actually changes (after
 * value differs from the current value — the writer's own delta rule); `documents` is the set of fields a
 * document was supplied for. Returns every violation, in grid order, so a caller can name the first.
 */
export function movementFieldRuleViolations(
  rules: readonly MovementFieldRule[],
  changed: ReadonlySet<string>,
  documents: ReadonlySet<string>,
): MovementFieldRuleViolation[] {
  const out: MovementFieldRuleViolation[] = [];
  for (const r of rules) {
    const didChange = changed.has(r.field);
    if (!r.included && didChange) out.push({ code: 'field_not_included', field: r.field });
    else if (r.included && !r.editable && didChange) out.push({ code: 'field_not_editable', field: r.field });
    if (r.mustChange && !didChange) out.push({ code: 'field_must_change', field: r.field });
    if (documents.has(r.field) && r.document === 'none') out.push({ code: 'document_not_enabled', field: r.field });
    if (r.document === 'required' && didChange && !documents.has(r.field)) {
      out.push({ code: 'document_required', field: r.field });
    }
  }
  // A document for a field the grid does not offer at all (company on a non-Entity-Transfer type).
  for (const f of documents) {
    if (!rules.some((r) => r.field === f) && isMovementRuleField(f)) out.push({ code: 'document_not_enabled', field: f });
  }
  return out;
}

/** True when any field of the grid requires a document when it changes — the import cannot carry files. */
export const movementRulesNeedDocument = (rules: readonly MovementFieldRule[]): boolean =>
  rules.some((r) => r.document === 'required');

/** Supporting documents (core/movement-attachments.ts; migration 0722's CHECKs hold the same bounds). */
export const MOVEMENT_DOCUMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export const MOVEMENT_DOCUMENT_MAX_BYTES = 5 * 1024 * 1024;
export const MOVEMENT_DOCUMENT_MAX_FILES = 5;
export const MOVEMENT_DOCUMENT_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
