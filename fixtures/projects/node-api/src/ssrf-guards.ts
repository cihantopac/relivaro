import dns from 'node:dns/promises';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { isPrivateAddress } from './net-policy';

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
