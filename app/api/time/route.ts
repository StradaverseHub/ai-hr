import { clockApiSession } from '@/lib/attendance-clock-session';
export async function GET() {
  if(!await clockApiSession()) return Response.json({error:'authentication'},{status:401});
  return Response.json({ serverNow: new Date().toISOString() }, { headers: { 'Cache-Control': 'private, no-store' } });
}
