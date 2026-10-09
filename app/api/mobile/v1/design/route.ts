import { publishedMobileDesign } from '@/core/mobile-design';
import { MobileDesignResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';

/** Tenant comes only from verified bearer identity. Drafts never cross this boundary. */
export const GET = mobileRoute(MobileDesignResponse, s => publishedMobileDesign(s));
