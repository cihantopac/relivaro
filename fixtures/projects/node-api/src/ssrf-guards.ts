import dns from 'node:dns/promises';
import net from 'node:net';
import axios from 'axios';
import ipaddr from 'ipaddr.js';
import { Agent } from 'undici';
import { assertPublicUrl, isPrivateAddress, validateTarget } from './net-policy';

// Hostname deny checks that compare strings instead of resolved, canonical addresses.

export function assertNotLoopback(u: string): void {
  if (new URL(u).hostname === '127.0.0.1') throw new Error('loopback'); // expect: sec/ssrf-hostname-denylist
}

export function assertNotInternal(u: string): void {
  const h = new URL(u).hostname;
  if (['localhost', '169.254.169.254'].includes(h)) throw new Error('internal'); // expect: sec/ssrf-hostname-denylist
}

export function assertNotPrivateRange(x: string): void {
  const url = new URL(x);
  if (url.host.startsWith('10.')) throw new Error('private'); // expect: sec/ssrf-hostname-denylist
}

// Negative twins: the same comparison next to real canonicalisation.

export function assertNotLoopbackIp(u: string): void {
  const h = new URL(u).hostname;
  if (h === '127.0.0.1' || !net.isIP(h)) throw new Error('loopback');
}

const blocked = new net.BlockList();
blocked.addSubnet('10.0.0.0', 8);

export function assertNotBlocked(u: string): void {
  const h = new URL(u).hostname;
  if (h === 'localhost' || blocked.check(h)) throw new Error('blocked');
}

export function assertPublicAddr(u: string): void {
  const h = new URL(u).hostname;
  if (h === '169.254.169.254' || ipaddr.parse(h).range() !== 'unicast') throw new Error('not public');
}

export async function assertResolvesPublic(u: string): Promise<void> {
  const url = new URL(u);
  if (url.hostname === 'localhost') throw new Error('loopback');
  const { address } = await dns.lookup(url.hostname);
  if (address.startsWith('127.')) throw new Error('loopback');
}

function isReservedHost(h: string): boolean {
  const list = new net.BlockList();
  list.addAddress('127.0.0.1');
  return list.check(h);
}

export function assertNotReserved(u: string): void {
  const h = new URL(u).hostname;
  if (h === '127.0.0.1' || isReservedHost(h)) throw new Error('reserved');
}

export function assertNotPrivateImported(u: string): void {
  const h = new URL(u).hostname;
  if (h === '10.0.0.1' || isPrivateAddress(h)) throw new Error('private');
}

export function assertAllowedApi(u: string): void {
  if (new URL(u).hostname !== 'api.example.com') throw new Error('not allowed');
}

export function describeTarget(u: string): string {
  const local = new URL(u).hostname === 'localhost';
  return local ? 'local' : 'remote';
}

// Guarded requests that still follow redirects.

export async function fetchPublic(u: string): Promise<Response> {
  await assertPublicUrl(u);
  return fetch(u); // expect: sec/ssrf-redirect-bypass
}

export async function fetchTarget(u: string): Promise<unknown> {
  validateTarget(u);
  return axios.get(u, { timeout: 5000 }); // expect: sec/ssrf-redirect-bypass
}

export async function fetchNotLoopback(u: string): Promise<Response> {
  assertNotLoopback(u);
  return fetch(u, { redirect: 'follow' }); // expect: sec/ssrf-redirect-bypass
}

// Negative twins: redirects off, unknown options, a pinned dispatcher, or no guard at all.

const noFollow = { redirect: 'error' as const };
const pinned = new Agent({ connect: { lookup: pinnedLookup } });

function pinnedLookup(host: string, opts: object, cb: (err: Error | null, address: string, family: number) => void): void {
  cb(null, host, 4);
}

export async function fetchManual(u: string): Promise<Response> {
  await assertPublicUrl(u);
  return fetch(u, { redirect: 'manual' });
}

export async function fetchSpreadManual(u: string, base: RequestInit): Promise<Response> {
  await assertPublicUrl(u);
  return fetch(u, { ...base, redirect: 'manual' });
}

export async function fetchNamedOptions(u: string): Promise<Response> {
  await assertPublicUrl(u);
  return fetch(u, noFollow);
}

export async function fetchUnknownOptions(u: string, opts: RequestInit): Promise<Response> {
  await assertPublicUrl(u);
  return fetch(u, { ...opts });
}

export async function axiosNoRedirects(u: string): Promise<unknown> {
  validateTarget(u);
  return axios.get(u, { maxRedirects: 0, timeout: 5000 });
}

export async function fetchPinned(u: string): Promise<Response> {
  await assertPublicUrl(u);
  return fetch(u, { dispatcher: pinned } as RequestInit);
}

export async function fetchUnguarded(u: string): Promise<Response> {
  return fetch(u);
}
