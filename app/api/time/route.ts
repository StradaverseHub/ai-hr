import {capacityAwareRoute} from '@/lib/database-degraded';
import { clockApiSession } from '@/lib/attendance-clock-session';
export const GET = capacityAwareRoute(async function GET() {
  if(!await clockApiSession()) return Response.json({error:'authentication'},{status:401});
  return Response.json({ serverNow: new Date().toISOString() }, { headers: { 'Cache-Control': 'private, no-store' } });
});
