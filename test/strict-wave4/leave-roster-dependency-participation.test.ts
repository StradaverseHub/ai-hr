/** CI-only strict-mode run of test/leave-roster-dependency-participation.test.ts: every application session carries app.access_lock_strict and
 * AIHR_ACCESS_LOCK_STRICT refuses shared-to-exclusive upgrades. Not for merge. */
import {vi} from 'vitest';
vi.hoisted(()=>{const url=new URL(process.env.DATABASE_URL!);url.searchParams.set('app.access_lock_strict','on');process.env.DATABASE_URL=url.toString();process.env.AIHR_ACCESS_LOCK_STRICT='on';});
import '../leave-roster-dependency-participation.test';
