import {createIntegrityKeyHttpHandlers} from '@/lib/mobile-api/integrity-key-routes';
export const GET=createIntegrityKeyHttpHandlers().keys;
