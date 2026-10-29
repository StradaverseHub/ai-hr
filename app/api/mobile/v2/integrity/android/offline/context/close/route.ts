import {mobileRoute} from '@/lib/mobile-api/handler';
import {createOfflineSyncOperations} from '@/lib/mobile-api/offline-sync-routes';
import {OfflineCloseResult} from '@/lib/mobile-offline-contract';
const operations=createOfflineSyncOperations('android');
export const POST = mobileRoute(OfflineCloseResult,operations.close);
