import {createIntegrityKeyHttpHandlers} from '@/lib/mobile-api/integrity-key-routes';
export const POST=createIntegrityKeyHttpHandlers().revoke;
