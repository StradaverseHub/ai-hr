import {mobileRoute} from '@/lib/mobile-api/handler';
import {createOfflineSyncOperations} from '@/lib/mobile-api/offline-sync-routes';
import {OfflineContextResult} from '@/lib/mobile-offline-contract';
const operations=createOfflineSyncOperations('android');
export const POST = mobileRoute(OfflineContextResult,operations.context);
