import {mobileRoute} from '@/lib/mobile-api/handler';
import {createOfflineSyncOperations} from '@/lib/mobile-api/offline-sync-routes';
import {OfflineCapabilitiesResult} from '@/lib/mobile-offline-contract';
const operations=createOfflineSyncOperations('android');
export const GET = mobileRoute(OfflineCapabilitiesResult,operations.capabilities);
