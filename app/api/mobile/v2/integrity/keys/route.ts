import {createIntegrityKeyHttpHandlers} from '@/lib/mobile-api/integrity-key-routes';
export const GET=createIntegrityKeyHttpHandlers(undefined,2).keys;
