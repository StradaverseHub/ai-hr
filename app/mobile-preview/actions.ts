'use server';
import { MOBILE_BACKGROUND_INPUT_BYTES, uploadMobileBackground, MobileArtworkError } from '@/core/mobile-backgrounds';
import { isGroupAdmin } from '@/lib/authz-model';
import { getSession } from '@/lib/session';
import { scopedSession } from '@/lib/scope';
import { changeMobileDesign, mobileBuilderState, MobileDesignError } from '@/core/mobile-design';

export async function changeMobileDesignAction(command: 'save' | 'publish' | 'rollback', expectedRevision: number, value?: unknown) {
  const { s } = await scopedSession();
  try {
    await changeMobileDesign(s, command, expectedRevision, value);
    return { ok: true as const, state: await mobileBuilderState(s) };
  } catch (e) {
    if (e instanceof MobileDesignError) return { ok: false as const, error: e.reason };
    console.error('[mobile-builder] mutation failed', e);
    return { ok: false as const, error: 'unavailable' as const };
  }
}

/** The authorized action returns an immutable asset id; no original upload is ever served. */
export async function uploadMobileBackgroundAction(form: FormData) {
  const s = await getSession();
  if (!s.userId || !isGroupAdmin(s)) return { ok: false as const, error: 'forbidden' as const };
  const file = form.get('file');
  if (!(file instanceof File) || !['image/png', 'image/jpeg'].includes(file.type) || !file.size || file.size > MOBILE_BACKGROUND_INPUT_BYTES) return { ok: false as const, error: 'backgroundInvalid' as const };
  try { return { ok: true as const, asset: await uploadMobileBackground(s, new Uint8Array(await file.arrayBuffer())) }; }
  catch (e) { return { ok: false as const, error: e instanceof MobileArtworkError ? e.reason : 'backgroundInvalid' as const }; }
}
