'use client';

import { useState } from 'react';
import { Button, inputCls } from './ui';
import { ConfirmSubmit } from './ui/confirm-submit';

type FieldDef = { name: string; label: string; value: string };

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
  deleteAction: (fd: FormData) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li className="px-4 py-2.5">
        <form action={updateAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="id" value={id} />
          {fields.map((f) => (
            <input
              key={f.name}
              name={f.name}
              defaultValue={f.value}
              placeholder={f.label}
              aria-label={f.label}
              className={`${inputCls} w-44`}
            />
          ))}
          <Button type="submit" size="sm">
            Save
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
            Cancel
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
            archived
          </span>
        )}
        {sub && <span className="ml-2 text-xs text-muted-foreground">{sub}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
          Edit
        </Button>
        {archived ? (
          <form action={archiveAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="archived" value="false" />
            <Button type="submit" size="sm" variant="ghost">
              Unarchive
            </Button>
          </form>
        ) : inUse ? (
          <form action={archiveAction}>
            <input type="hidden" name="id" value={id} />
            <input type="hidden" name="archived" value="true" />
            <Button type="submit" size="sm" variant="ghost">
              Archive
            </Button>
          </form>
        ) : (
          <form action={deleteAction}>
            <input type="hidden" name="id" value={id} />
            <ConfirmSubmit
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              title="Delete this record?"
              description="It isn't referenced anywhere, so this permanently removes it."
              confirmLabel="Delete"
            >
              Delete
            </ConfirmSubmit>
          </form>
        )}
      </div>
    </li>
  );
}
