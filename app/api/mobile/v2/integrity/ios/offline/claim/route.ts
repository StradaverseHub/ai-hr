import {mobileRoute} from '@/lib/mobile-api/handler';
import {createOfflineSyncOperations} from '@/lib/mobile-api/offline-sync-routes';
import {OfflineClaimResult} from '@/lib/mobile-offline-contract';
const operations=createOfflineSyncOperations('ios');
export const POST = mobileRoute(OfflineClaimResult,operations.claim);
