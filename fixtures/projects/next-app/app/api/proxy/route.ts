import { NextResponse } from 'next/server';

export async function GET(request: Request) {
  const target = new URL(request.url).searchParams.get('target');
  const upstream = await fetch(target!); // expect: sec/ssrf
  return new NextResponse(await upstream.text());
}

export async function POST(request: Request) {
  const body = await request.json();
  const res = await fetch(`https://api.example.com/v2/items/${body.id}`, { signal: AbortSignal.timeout(5000) });
  return NextResponse.json(await res.json());
}
