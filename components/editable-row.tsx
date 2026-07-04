'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

/** A field renders as a plain text input by default; supply `options` to render a `<select>` instead
 *  (used for the Department↔Business-Unit dropdown). `value` is the pre-selected option value.
 *  `wide` widens the input beyond the default w-44 slot — for free-text like the System Labels
 *  description, which would be cramped in a code/name-sized box. */
type FieldDef = {
  name: string;
  label: string;
  value: string;
  options?: { value: string; label: string }[];
  wide?: boolean;
};

/**
 * A list row with inline edit + state-aware remove (ADR-0006): delete when unreferenced
 * (a genuine mistake), archive when in use (reversible, keeps history). Server actions are
 * passed in by the page.
 */
export function EditableRow({
  id,
  display,
  sub,
  fields,
  inUse,
  archived,
  updateAction,
  archiveAction,
  deleteAction,
}: {
  id: string;
  display: string;
  sub?: string | null;
  fields: FieldDef[];
  inUse: boolean;
  archived: boolean;
  updateAction: (fd: FormData) => void;
  archiveAction: (fd: FormData) => void;
  // Optional: catalogs without a hard-delete path (e.g. Business Unit) archive instead of delete.
  deleteAction?: (fd: FormData) => void;
}) {
  const t = useTranslations('components.editableRow');
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="px-4 py-2.5">
        <form action={updateAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="id" value={id} />
          {fields.map((f) =>
            f.options ? (
              <select
                key={f.name}
                name={f.name}
                defaultValue={f.value}
                aria-label={f.label}
                className={`${inputCls} w-44`}
              >
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                key={f.name}
                name={f.name}
                defaultValue={f.value}
                placeholder={f.label}
                aria-label={f.label}
                className={`${inputCls} ${f.wide ? 'w-72' : 'w-44'}`}
              />
            ),
          )}
          <Button type="submit" size="sm">
            {t('save')}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
            {t('cancel')}
          </Button>
        </form>
      </li>
    );
  }

  return (
    <li className={`flex items-center justify-between gap-3 px-4 py-2.5 text-sm ${archived ? 'opacity-60' : ''}`}>
      <div className="min-w-0">
        <span className="text-foreground">{display}</span>
        {archived && (
          <span className="ml-2 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('archivedBadge')}
          </span>
        )}
        {sub && <span className="ml-2 text-xs text-muted-foreground">{sub}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
          {t('edit')}
        </Button>
        {archived ? (
          <form action={archiveAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="archived" value="false" />
            <Button type="submit" size="sm" variant="ghost">
              {t('unarchive')}
            </Button>
          </form>
        ) : inUse || !deleteAction ? (
          <form action={archiveAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="archived" value="true" />
            <Button type="submit" size="sm" variant="ghost">
              {t('archive')}
            </Button>
          </form>
        ) : (
          <form action={deleteAction}>
            <input type="hidden" name="id" value={id} />
            <ConfirmSubmit
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              title={t('deleteTitle')}
              description={t('deleteDescription')}
              confirmLabel={t('deleteConfirm')}
            >
              {t('delete')}
            </ConfirmSubmit>
          </form>
        )}
      </div>
    </li>
  );
}
