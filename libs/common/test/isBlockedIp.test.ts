import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBlockedIp, validateUrl } from '../safeFetch.js';

describe('isBlockedIp – dải IPv4 bắt buộc', () => {
  const blocked = [
    '127.0.0.1', '127.255.255.254', // 127.0.0.0/8
    '10.0.0.1', '10.255.255.255', // 10.0.0.0/8
    '172.16.0.1', '172.31.255.255', // 172.16.0.0/12
    '192.168.0.1', '192.168.255.255', // 192.168.0.0/16
    '169.254.169.254', '169.254.0.1', // link-local + metadata
    '0.0.0.0', '0.255.255.255', // 0.0.0.0/8
  ];
  for (const ip of blocked) it(`chặn ${ip}`, () => assert.equal(isBlockedIp(ip), true));
});

describe('isBlockedIp – dải IPv4 chặn thêm', () => {
  for (const ip of ['100.64.0.1', '100.127.255.255', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255']) {
    it(`chặn ${ip}`, () => assert.equal(isBlockedIp(ip), true));
  }
});

describe('isBlockedIp – IPv4 công khai sát biên không bị chặn nhầm', () => {
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '169.253.255.255', '11.0.0.0', '9.255.255.255', '223.255.255.255']) {
    it(`cho phép ${ip}`, () => assert.equal(isBlockedIp(ip), false));
  }
});

describe('isBlockedIp – IPv6', () => {
  const blocked = [
    '::1', '0:0:0:0:0:0:0:1', '[::1]', '::',
    'fc00::1', 'fd00::1', 'fdff:ffff::1', 'fd00:ec2::254', // fc00::/7 (gồm IMDS IPv6 của AWS)
    'fe80::1', 'febf::1', // fe80::/10
    'ff02::1', 'fec0::1',
  ];
  for (const ip of blocked) it(`chặn ${ip}`, () => assert.equal(isBlockedIp(ip), true));
  for (const ip of ['2606:2800:220:1:248:1893:25c8:1946', '2001:4860:4860::8888', '2a00:1450::1']) {
    it(`cho phép ${ip}`, () => assert.equal(isBlockedIp(ip), false));
  }
});

describe('isBlockedIp – IPv4 nhúng trong IPv6 (tự kiểm tra, không dựa net.BlockList)', () => {
  const blocked = [
    '::ffff:127.0.0.1', '::FFFF:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:0001',
    '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '::ffff:192.168.1.1', '::ffff:0.0.0.0',
    '::127.0.0.1', // IPv4-compatible (lỗi thời)
    '::ffff:0:127.0.0.1', // IPv4-translated
    '64:ff9b::10.0.0.1', '64:ff9b::7f00:1', // NAT64
    '2002:7f00:1::1', '2002:a9fe:a9fe::', // 6to4
  ];
  for (const ip of blocked) it(`chặn ${ip}`, () => assert.equal(isBlockedIp(ip), true));
  for (const ip of ['::ffff:93.184.216.34', '::ffff:5db8:d822', '64:ff9b::8.8.8.8']) {
    it(`cho phép ${ip} (IPv4 nhúng là công khai)`, () => assert.equal(isBlockedIp(ip), false));
  }
});

describe('isBlockedIp – dạng lạ / không hợp lệ bị chặn (fail-closed)', () => {
  for (const ip of ['2130706433', '0x7f.1', '0x7f000001', '0177.0.0.1', '127.1', '127.0.0.1.', '256.1.1.1', '', 'abc', '1:2:3:4:5:6:7:8:9', '1:::2', 'fe80::1%eth0', '::ffff:999.0.0.1']) {
    it(`chặn ${JSON.stringify(ip)}`, () => assert.equal(isBlockedIp(ip), true));
  }
});

describe('validateUrl', () => {
  const cases: Array<[string, string]> = [
    ['ftp://example.com/', 'SCHEME'],
    ['file:///etc/passwd', 'SCHEME'],
    ['gopher://example.com/', 'SCHEME'],
    ['javascript:alert(1)', 'SCHEME'],
    ['http://user:pass@example.com/', 'CREDENTIALS'],
    ['http://user@example.com/', 'CREDENTIALS'],
    ['http://example.com:22/', 'PORT'],
    ['http://example.com:8080/', 'PORT'],
    ['https://example.com:6379/', 'PORT'],
    ['not a url', 'INVALID_URL'],
    ['http://', 'INVALID_URL'],
  ];
  for (const [url, reason] of cases) {
    it(`${url} -> ${reason}`, () => {
      const r = validateUrl(url);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, reason);
    });
  }

  it('chuẩn hoá IP thập phân/hex/bát phân về dạng chấm trước khi kiểm tra', () => {
    for (const u of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://0x7f000001/', 'http://127.1/']) {
      const r = validateUrl(u);
      assert.equal(r.ok, true, u);
      if (r.ok) assert.equal(r.ipLiteral, '127.0.0.1', u);
    }
  });

  it('nhận diện IPv6 literal trong ngoặc vuông', () => {
    const r = validateUrl('http://[::ffff:127.0.0.1]/');
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(isBlockedIp(r.ipLiteral ?? ''), true);
  });

  it('URL hợp lệ: http/https cổng 80/443', () => {
    for (const u of ['http://example.com/', 'https://example.com/a?b=1', 'http://example.com:80/', 'https://example.com:443/']) {
      assert.equal(validateUrl(u).ok, true, u);
    }
  });
});
