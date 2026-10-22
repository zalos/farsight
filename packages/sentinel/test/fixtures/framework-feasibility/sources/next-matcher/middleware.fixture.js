// Synthetic Sentinel E2 fixture (next-matcher). Original, inert, never installed outside a bounded
// probe container. The declared matcher names which requests this file sees at all; what the function
// body then does with a matched request is a second, separate decision no matcher config can show.
import { NextResponse } from 'next/server';

export function middleware(request) {
  // Matched by config.matcher below, but explicitly let through: inclusion in the matcher is necessary,
  // not sufficient, for a request to actually be blocked.
  if (request.nextUrl.pathname === '/api/dashboard/open') return NextResponse.next();
  return NextResponse.json({ blocked: 'middleware' }, { status: 403 });
}

export const config = {
  matcher: ['/api/dashboard/:path*'],
};
