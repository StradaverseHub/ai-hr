import { NextRequest, NextResponse } from 'next/server';
import { keycloakSelected, keycloakReady } from '@/lib/identity/config';
import { startKeycloakLogin } from '@/lib/identity/login';
export async function GET(request: NextRequest) {
  if (!keycloakSelected()) return new NextResponse(null, { status: 404 });
  if (!keycloakReady()) return new NextResponse('Sign-in is not configured.', { status: 503, headers: { 'cache-control': 'no-store' } });
  try { return await startKeycloakLogin(request); }
  catch { return new NextResponse('Sign-in is temporarily unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } }); }
}
