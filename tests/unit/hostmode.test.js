import { describe, it, expect } from 'vitest';
const { hostConfigView, lanUrls, pairUrl } = require('../../core/hostmode');

describe('hostConfigView', () => {
  it('defaults: disabled mirror on 4321', () => {
    expect(hostConfigView()).toEqual({ enabled: false, mode: 'mirror', port: 4321 });
    expect(hostConfigView({})).toEqual({ enabled: false, mode: 'mirror', port: 4321 });
    expect(hostConfigView(null)).toEqual({ enabled: false, mode: 'mirror', port: 4321 });
  });
  it('keeps valid values', () => {
    expect(hostConfigView({ enabled: 1, mode: 'family', port: 5000 })).toEqual({ enabled: true, mode: 'family', port: 5000 });
  });
  it('garbage mode -> mirror, garbage port -> 4321', () => {
    expect(hostConfigView({ mode: 'weird', port: 'abc' })).toEqual({ enabled: false, mode: 'mirror', port: 4321 });
    expect(hostConfigView({ mode: 'FAMILY', port: 0 })).toEqual({ enabled: false, mode: 'mirror', port: 4321 });
    expect(hostConfigView({ port: 99999 })).toEqual({ enabled: false, mode: 'mirror', port: 4321 });
  });
});

describe('lanUrls', () => {
  const ifaces = {
    en0: [
      { address: '192.168.1.42', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    utun3: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    bridge: [{ address: '172.16.4.9', family: 'IPv4', internal: false }],
  };
  it('IPv4 non-internal only, home ranges first', () => {
    expect(lanUrls(ifaces, 4321)).toEqual([
      'http://192.168.1.42:4321',
      'http://10.0.0.5:4321',
      'http://172.16.4.9:4321',
    ]);
  });
  it('filters IPv6 + internal even when mixed', () => {
    const out = lanUrls({ x: [{ address: '::1', family: 'IPv6', internal: true }, { address: '10.1.2.3', family: 'IPv4', internal: false }] }, 80);
    expect(out).toEqual(['http://10.1.2.3:80']);
  });
  it('no interfaces -> []', () => {
    expect(lanUrls({}, 4321)).toEqual([]);
    expect(lanUrls(null, 4321)).toEqual([]);
    expect(lanUrls(undefined, 4321)).toEqual([]);
  });
});

describe('pairUrl', () => {
  it('builds <base>/?pair=<token>', () => {
    expect(pairUrl('http://192.168.1.42:4321', 'abc123')).toBe('http://192.168.1.42:4321/?pair=abc123');
  });
  it('trims trailing slashes + encodes the token', () => {
    expect(pairUrl('http://x:1/', 'a b')).toBe('http://x:1/?pair=a%20b');
    expect(pairUrl('http://x:1//', 't')).toBe('http://x:1/?pair=t');
  });
  it('empty base -> empty string', () => {
    expect(pairUrl('', 't')).toBe('');
    expect(pairUrl(null, 't')).toBe('');
  });
});
