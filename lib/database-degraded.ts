/**
 * What an HTTP caller receives when the database has no capacity left for it: 503 with Retry-After
 * and a translated message, never the framework's bare 500.
 */
import {getTranslations} from 'next-intl/server';
import {isDatabaseCapacityFailure} from '../db/read-retry';
import {withIdempotentDatabaseRead} from '../db/workload';
import {DATABASE_RETRY_AFTER_SECONDS} from './database-capacity';

export async function databaseUnavailableResponse(): Promise<Response> {
  const t = await getTranslations('common.degraded');
  return Response.json({error: 'temporarily_unavailable', message: t('apiMessage')}, {
    status: 503,
    headers: {'retry-after': String(DATABASE_RETRY_AFTER_SECONDS), 'cache-control': 'no-store'},
  });
}

/** Turns a capacity failure into a retriable response. It never re-runs the handler. */
export function capacityAwareRoute<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (isDatabaseCapacityFailure(error)) return databaseUnavailableResponse();
      throw error;
    }
  };
}

/**
 * For handlers verified to perform no write: transactions inside retry invisibly after a capacity
 * failure before the 503 is sent. A handler that writes must use capacityAwareRoute instead.
 */
export function capacityAwareRead<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return capacityAwareRoute((...args: A) => withIdempotentDatabaseRead(() => handler(...args)));
}
