'use client';

/**
 * Board 2c1b2fba — THE DRAFT'S PROFILE PHOTO, in the header card.
 *
 * The activated record's control (app/admin/personnel/[employmentId]/page.tsx header + PhotoEditMenu):
 * the avatar, an Edit photo trigger, Upload / Replace and Remove, PNG or JPG up to 2 MB, in the record's own
 * words (`people.detail.photo*`). It differs in one way only: the record posts forms to server actions
 * that redirect, and a draft is a client screen, so the same two actions are CALLED here and the result
 * repaints the avatar in place.
 *
 * THE PHOTO IS NOT PART OF THE DRAFT'S JSON. It is stored beside the draft (`employee_draft_photo`, written
 * by `uploadDraftPhotoAction`), served by GET /admin/personnel/new/photo?draft=<id> under the draft page's
 * own guard, and moved onto the person at Activate. Save draft neither sends nor needs it.
 *
 * The size and type are checked here first so a 6 MB file is refused before it is uploaded; the server
 * re-checks both (magic bytes, not the file name) and is the authority.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Avatar, Button } from '@/components/ui';
import { PhotoEditMenu } from '@/components/photo-edit-menu';
import { personnelInput } from '@/lib/personnel-form-contract';
import { PHOTO_MAX_BYTES } from '@/lib/profile-photo-limits';
import { removeDraftPhotoAction, uploadDraftPhotoAction } from './actions';

const PHOTO_TYPES = ['image/png', 'image/jpeg'];
type PhotoError = 'invalid' | 'too_large' | 'type' | 'permission' | 'unavailable';

export const draftPhotoSrc = (draftId: string, version: number | null) =>
  `/admin/personnel/new/photo?draft=${encodeURIComponent(draftId)}${version ? `&v=${version}` : ''}`;

export function DraftPhoto({ draftId, name, hasPhoto }: { draftId: string; name: string; hasPhoto: boolean }) {
  const t = useTranslations('people');
  const [present, setPresent] = useState(hasPhoto);
  const [version, setVersion] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<PhotoError | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);

  // Static keys per refusal, never a computed one (i18n coverage check C).
  const errorText = (e: PhotoError) => {
    switch (e) {
      case 'too_large': return t('wizard.photoErrorTooLarge');
      case 'type': return t('wizard.photoErrorType');
      case 'permission': return t('wizard.photoErrorPermission');
      case 'unavailable': return t('wizard.photoErrorUnavailable');
      default: return t('wizard.photoErrorInvalid');
    }
  };
  const clearPick = () => {
    if (preview) URL.revokeObjectURL(preview);
    setFile(null);
    setPreview(null);
  };
  const pick = (f: File | null) => {
    clearPick();
    setError(null);
    if (!f) return;
    if (!PHOTO_TYPES.includes(f.type)) return setError('type');
    if (f.size > PHOTO_MAX_BYTES) return setError('too_large');
    setFile(f);
    try {
      setPreview(URL.createObjectURL(f));
    } catch {
      setPreview(null);
    }
  };
  const upload = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('draftId', draftId);
      form.append('file', file);
      const result = await uploadDraftPhotoAction(form);
      if (result.ok) {
        setPresent(true);
        setVersion(Date.now());
        clearPick();
      } else setError(result.error);
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await removeDraftPhotoAction(draftId);
      if (result.ok) {
        setPresent(false);
        setVersion(null);
        setConfirmRemove(false);
      } else setError(result.error);
    } catch {
      setError('unavailable');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2" data-draft-photo>
      <Avatar name={name} src={preview ?? (present ? draftPhotoSrc(draftId, version) : null)} className="size-20 text-xl" />
      <PhotoEditMenu
        label={t('detail.photoEdit')}
        hint={t('detail.photoHint')}
        onClose={() => {
          clearPick();
          setConfirmRemove(false);
        }}
      >
        <div className="flex w-full flex-col items-stretch gap-1.5">
          <input
            {...personnelInput('profile.personal_details.photo', 'draft')}
            accept="image/png,image/jpeg"
            aria-label={present ? t('detail.photoReplace') : t('detail.photoUpload')}
            disabled={busy}
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
            className="w-full text-xs text-muted-foreground file:mr-2 file:rounded-md file:border-0 file:bg-accent file:px-2 file:py-1 file:text-xs file:text-foreground"
          />
          <Button type="button" size="sm" className="w-full" disabled={!file || busy} onClick={upload}>
            {present ? t('detail.photoReplace') : t('detail.photoUpload')}
          </Button>
        </div>
        {present &&
          (confirmRemove ? (
            <div className="flex w-full flex-col gap-1.5 text-center text-xs">
              <span>{t('detail.photoRemoveConfirm')}</span>
              <div className="flex justify-center gap-2">
                <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={remove}>
                  {t('wizard.yes')}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setConfirmRemove(false)}>
                  {t('wizard.no')}
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" size="sm" variant="outline" className="w-full" disabled={busy} onClick={() => setConfirmRemove(true)}>
              {t('detail.photoRemove')}
            </Button>
          ))}
      </PhotoEditMenu>
      {/* A refusal is shown under the trigger rather than inside the menu, so it survives the menu closing
          (closing unmounts the menu's children — see components/photo-edit-menu.tsx). */}
      {error && <p role="alert" className="max-w-40 text-center text-xs text-destructive" data-draft-photo-error>{errorText(error)}</p>}
    </div>
  );
}
