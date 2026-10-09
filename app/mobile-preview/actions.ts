'use server';
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
