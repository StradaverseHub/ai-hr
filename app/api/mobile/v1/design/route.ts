import { publishedMobileDesign } from '@/core/mobile-design';
import { MobileDesignResponse } from '@/lib/mobile-api/contract';
import { legacyMobileDesign, mobileDesignWithoutBackgrounds } from '@/lib/mobile-design';
import { MobileBadRequest, mobileRoute } from '@/lib/mobile-api/handler';

/** Tenant comes only from verified bearer identity. Drafts never cross this boundary. */
export const GET = mobileRoute(MobileDesignResponse, async (s, req) => {
  const version = new URL(req.url).searchParams.get('schema') ?? '1';
  if (!['1', '2'].includes(version)) throw new MobileBadRequest('unsupported_design');
  const artwork = new URL(req.url).searchParams.get('artwork');
  if (artwork !== null && artwork !== '1') throw new MobileBadRequest('unsupported_design');
  const release = await publishedMobileDesign(s, version === '2' && artwork === '1');
  return { ...release, config: version === '2' ? artwork === '1' ? release.config : mobileDesignWithoutBackgrounds(release.config) : legacyMobileDesign(release.config) };
});
