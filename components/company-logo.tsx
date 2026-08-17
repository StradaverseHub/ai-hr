'use client';

/**
 * The company logo: the read-only mark, and the edit affordance next to it (item 3c2f55d7 rev 2).
 *
 * WHY THIS IS ITS OWN FILE. `CompanyLogo` used to be a private helper inside components/company-panel.tsx.
 * The redesign puts the logo at the TOP of the General tab with the same interaction the Personnel
 * profile photo has (a pencil trigger over a popover holding the upload / remove forms — see
 * components/photo-edit-menu.tsx), plus one thing the Personnel photo does NOT have: a PREVIEW of the
 * chosen file before it is saved. The preview needs `URL.createObjectURL` and therefore state, so the
 * edit affordance is an island of its own rather than more markup in an already 900-line panel.
 *
 * NOTHING IS TRANSLATED HERE. Every caption arrives pre-translated as a prop, the way PhotoEditMenu and
 * EmployeeSearchField take theirs, so the i18n static-key guard still sees the `t('…')` lookups on the
 * screen that owns the namespace and this file needs no namespace of its own.
 *
 * THE UPLOAD CONTRACT IS UNCHANGED. The same `<form action={setAction}>` posts the same `companyId` +
 * `logo` file field to the same server action (PNG/JPG, 2 MB, sniffed server-side — app/admin/actions.ts).
 * The preview is a local object URL and is never submitted; picking a file and walking away saves nothing.
 *
 * THE PREVIEW MUST NOT OUTLIVE THE FORM. PhotoEditMenu renders its children behind `{open && …}` and its
 * backdrop is `fixed inset-0`, so ANY click outside the popover unmounts the file input — the picked file
 * is gone at that instant. Keeping the preview on screen after that left the reader looking at an unsaved
 * image captioned "press <submit> to apply" next to a submit button that no longer existed. So the preview
 * is torn down (and its object URL revoked) on the menu's `onClose`, which fires on every close path.
 * Pinned by test/company-logo-edit.dom.test.tsx.
 */

import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Avatar } from './ui';
import { PhotoEditMenu } from './photo-edit-menu';

type Action = (fd: FormData) => void | Promise<void>;

/** The company's logo (served inline by the RLS-scoped logo route) or the initials Avatar placeholder when
 *  none is set. On an <img> load error (e.g. a corrupt-but-sniffed file) it falls back to the Avatar. */
export function CompanyLogo({
  hasLogo,
  companyId,
  name,
  className,
}: {
  hasLogo: boolean;
  companyId: string;
  name: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (!hasLogo || broken) return <Avatar name={name} className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- dynamic bytea served by our RLS route; not a static asset
    <img
      src={`/admin/organization/logo/${companyId}`}
      alt=""
      onError={() => setBroken(true)}
      className={cn('size-8 shrink-0 rounded-full object-cover ring-1 ring-border', className)}
    />
  );
}

/** The five captions the edit affordance shows. All required: nothing here invents English. */
export type CompanyLogoLabels = {
  /** Pencil trigger, e.g. "Edit logo". */
  edit: string;
  /** Format + size limit line at the bottom of the popover, e.g. "PNG or JPG, up to 2 MB". */
  hint: string;
  /** Submit caption when there is no logo yet, e.g. "Upload logo". */
  upload: string;
  /** Submit caption when one is already stored, e.g. "Replace logo". */
  replace: string;
  /** Remove caption, e.g. "Remove logo". */
  remove: string;
  /** Shown under the placeholder when nothing is stored, e.g. "No logo set". */
  none: string;
  /** Shown while an unsaved file is being previewed. MUST name the submit button that is actually on
   *  screen, e.g. "Not saved yet — press Replace logo to apply". The caller interpolates it. */
  previewPending: string;
};

export function CompanyLogoEdit({
  companyId,
  name,
  hasLogo,
  labels,
  setAction,
  removeAction,
}: {
  companyId: string;
  name: string;
  hasLogo: boolean;
  labels: CompanyLogoLabels;
  setAction: Action;
  removeAction: Action;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  // The live object URL, kept out of state so revoking the previous one never depends on a re-render.
  const urlRef = useRef<string | null>(null);

  /** Drop the preview and release its object URL. Idempotent — safe on every close, picked or not. */
  const clearPreview = () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setPreview(null);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    clearPreview();
    if (!file) return;
    const url = URL.createObjectURL(file);
    urlRef.current = url;
    setPreview(url);
  };

  return (
    <div className="flex flex-col items-center gap-3">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local blob: URL for the unsaved pick
        <img
          src={preview}
          alt=""
          className="size-24 shrink-0 rounded-full object-cover ring-2 ring-primary"
          data-logo-preview
        />
      ) : (
        <CompanyLogo hasLogo={hasLogo} companyId={companyId} name={name} className="size-24 text-2xl" />
      )}

      <PhotoEditMenu label={labels.edit} hint={labels.hint} onClose={clearPreview}>
        <form action={setAction} className="flex w-full flex-col items-stretch gap-1.5">
          <input type="hidden" name="companyId" value={companyId} />
          <input
            type="file"
            name="logo"
            required
            accept="image/png,image/jpeg"
            onChange={onPick}
            className="w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-accent file:px-2 file:py-1 file:text-xs file:text-foreground"
          />
          <button className="inline-flex h-7 items-center justify-center rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground transition duration-150 ease-snappy hover:bg-primary/90 active:scale-[0.98]">
            {hasLogo ? labels.replace : labels.upload}
          </button>
        </form>
        {hasLogo && (
          <form action={removeAction} className="w-full">
            <input type="hidden" name="companyId" value={companyId} />
            <button className="inline-flex h-7 w-full items-center justify-center rounded-md border border-input px-2 text-xs font-medium text-destructive transition duration-150 ease-snappy hover:bg-accent active:scale-[0.98]">
              {labels.remove}
            </button>
          </form>
        )}
      </PhotoEditMenu>

      <p
        className={cn(
          'text-center text-[11px]',
          preview ? 'font-medium text-primary' : 'text-muted-foreground',
        )}
      >
        {preview ? labels.previewPending : hasLogo ? labels.hint : `${labels.none} · ${labels.hint}`}
      </p>
    </div>
  );
}
