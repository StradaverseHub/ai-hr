import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import Link from '@/components/intent-link';
import { requireAdmin } from '@/lib/authz';
import { CONFIGURABLE_BEHAVIOUR_KINDS, getMovementEventTypeForSettings } from '@/core/movement-type';
import { COMPARISON_KINDS } from '@/core/movement-kinds';
import { movementTypeControlsForSettings } from '@/core/movement-type-controls';
import { listTerminationReasons } from '@/core/termination-reason-catalog';
import { TERMINATION_REASON_CATEGORIES } from '@/core/termination-reason';
import { MOVEMENT_FORM_IDS } from '@/lib/movement-form-contract';
import { MOVEMENT_RULE_FIELDS, effectiveMovementFieldRules } from '@/lib/movement-field-rules';
import { personnelFormLabel } from '@/lib/personnel-form-contract';
import { pageWideCls } from '@/components/ui';
import { EventTypeForm, type EventTypeFormLabels } from './event-type-form';

const PAGE = '/admin/settings/movement';

/**
 * 1d58019a — the event-type CONFIGURATION PAGE, shared by /admin/settings/movement/types/new (code null) and
 * /admin/settings/movement/types/[code]. It replaces the Add/Edit modal: full width (pageWideCls), a
 * breadcrumb back to the list, and the cards in event-type-form.tsx.
 *
 * A SERVER COMPONENT handing the island serialisable values only — strings, booleans and {value,label} rows
 * computed here — exactly as the list page did for the dialog. The island must not import core/movement-type
 * (it pulls the pg driver through db/client) and is never handed a translator.
 *
 * Viewing is admin-only twice over: requireAdmin() here, and getMovementEventTypeForSettings's own check.
 * An unknown code is a 404, not an empty form that would silently create something on save.
 */
export async function EventTypeConfigPage({ code }: { code: string | null }) {
  const s = await requireAdmin();
  const t = await getTranslations('movementSettings');
  const tk = await getTranslations('people.detail.movement.eventType');
  const tPeople = await getTranslations('people.detail');

  const row = code ? await getMovementEventTypeForSettings(s, code) : null;
  if (code && !row) notFound();

  const shippedLabel = (k: string): string => {
    const key = k as 'transfer';
    return tk.has(key) ? tk(key) : k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
  };
  const title = row ? (row.label ?? shippedLabel(row.code)) : t('config.newTitle');
  const facts = row
    ? [
        row.builtIn ? t('config.builtInType') : t('config.customType'),
        row.active ? t('status.active') : t('status.inactive'),
        ...(row.inUse ? [t('inUse')] : []),
      ]
    : [t('config.newSubtitle')];

  /** The only behaviours a tenant may point one of its OWN types at — the consequence-free ones and, since
   *  1d58019a Step 2 (ADR-0166), Termination — as plain {value,label} rows, built here so the island never
   *  imports core/movement-type. */
  const behaviourOptions = CONFIGURABLE_BEHAVIOUR_KINDS.map((k) => ({ value: k as string, label: shippedLabel(k) }));

  // ── 1d58019a Step 2 — the Termination Reasons and Field Controls cards ─────────────────────────────────
  // Both reads are admin-only in the service as well as behind requireAdmin() above.
  const controls = row ? await movementTypeControlsForSettings(s, { code: row.code, behaviourKind: row.behaviourKind }) : null;
  const reasons = await listTerminationReasons(s);
  const ticked = controls?.reasonCodes ?? [];
  // Offer the active reasons, plus a switched-off one this type already ticks (so it can be unticked).
  const reasonOptions = reasons
    .filter((r) => r.active || ticked.includes(r.code))
    .map((r) => ({
      code: r.code,
      category: r.category,
      active: r.active,
      label: r.label ?? (r.builtIn ? tPeople(`movement.terminationReason.${r.code}` as 'movement.terminationReason.resignation') : r.code),
    }));
  const reasonGroups = TERMINATION_REASON_CATEGORIES.map((category) => ({
    category,
    label: tPeople(`movement.terminationReasonCategory.${category}` as 'movement.terminationReasonCategory.voluntary'),
  }));
  // The same field names the New Event form shows (the personnel field registry, translated).
  const resolveLabel = (key: string, fallback: string) =>
    key.startsWith('people.detail.') && tPeople.has(key.slice(14)) ? tPeople(key.slice(14)) : fallback;
  const fieldLabels = Object.fromEntries(
    MOVEMENT_RULE_FIELDS.map((f) => [f, personnelFormLabel(MOVEMENT_FORM_IDS[f], resolveLabel)]),
  );
  const initialRules = controls?.rules.length
    ? controls.rules
    : effectiveMovementFieldRules(row?.behaviourKind ?? '', []).rules;

  const labels: EventTypeFormLabels = {
    sections: {
      general: t('config.sections.general'),
      classification: t('config.sections.classification'),
      description: t('config.sections.description'),
      reasons: t('config.sections.reasons'),
      fields: t('config.sections.fields'),
    },
    name: t('columns.name'),
    namePlaceholder: t('addNamePlaceholder'),
    code: t('config.code'),
    codeAuto: t('config.codeAuto'),
    behaviour: t('columns.behaviour'),
    behaviourPlaceholder: t('addBehaviourPlaceholder'),
    behaviourHint: t('behaviourNotice'),
    builtInBehaviour: t('builtInBehaviour'),
    classificationHint: t('config.classificationHint'),
    classificationLocked: t('config.classificationLocked'),
    classificationBuiltIn: t('config.classificationBuiltIn'),
    termination: t('classification.termination'),
    nonTermination: t('classification.nonTermination'),
    optional: t('config.optional'),
    descriptionHint: t('config.descriptionHint'),
    descriptionPlaceholder: t('config.descriptionPlaceholder'),
    save: t('save'),
    saving: t('saving'),
    cancel: t('cancel'),
    controls: {
      reasonsHint: t('config.reasonsHint'),
      reasonsAllHint: t('config.reasonsAllHint'),
      reasonsManageHint: t('config.reasonsManageHint'),
      reasonSwitchedOff: t('status.inactive'),
      fieldsHint: t('config.fieldsHint'),
      fieldsNotApplicable: t('config.fieldsNotApplicable'),
      fieldsCompanyLocked: t('config.fieldsCompanyLocked'),
      columns: {
        field: t('config.fieldColumns.field'),
        include: t('config.fieldColumns.include'),
        edit: t('config.fieldColumns.edit'),
        mustChange: t('config.fieldColumns.mustChange'),
        file: t('config.fieldColumns.file'),
      },
      groups: {
        organisation: t('config.fieldGroups.organisation'),
        labels: t('config.fieldGroups.labels'),
        salary: t('config.fieldGroups.salary'),
      },
      documents: {
        none: t('config.documents.none'),
        optional: t('config.documents.optional'),
        required: t('config.documents.required'),
      },
    },
  };

  return (
    <div className={pageWideCls}>
      <div className="space-y-1">
        <nav aria-label={t('config.breadcrumb')} className="text-sm text-muted-foreground">
          <Link href={PAGE} className="hover:text-foreground">
            {t('title')}
          </Link>
          {' / '}
          <Link href={PAGE} className="hover:text-foreground">
            {t('tabs.types')}
          </Link>
          {' /'}
        </nav>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{facts.join(' · ')}</p>
      </div>

      <EventTypeForm
        code={row?.code ?? null}
        builtIn={row?.builtIn ?? false}
        initialLabel={row ? title : ''}
        initialBehaviourKind={row?.behaviourKind ?? ''}
        initialDescription={row?.description ?? ''}
        inUse={row?.inUse ?? false}
        behaviourLabel={row ? shippedLabel(row.behaviourKind) : ''}
        behaviourOptions={behaviourOptions}
        comparisonBehaviours={[...COMPARISON_KINDS]}
        reasonGroups={reasonGroups}
        reasonOptions={reasonOptions}
        initialReasonCodes={ticked}
        fieldLabels={fieldLabels}
        initialRules={initialRules}
        listHref={PAGE}
        labels={labels}
      />
    </div>
  );
}
