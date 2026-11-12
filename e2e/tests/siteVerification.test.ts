import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificationInstructions, verificationMethod } from '../demo/siteVerification';

test('website verification defaults to META and accepts FILE case-insensitively', () => {
  assert.equal(verificationMethod(undefined), 'META');
  assert.equal(verificationMethod('file'), 'FILE');
  assert.throws(() => verificationMethod('DNS'), /META hoặc FILE/u);
});

test('FILE instructions identify the exact root path and plain token content', () => {
  assert.equal(
    verificationInstructions('FILE', 'translateme-verify-ab123', 'https://tenant.example/path/'),
    'Đặt nguyên văn token sau vào https://tenant.example/translateme-verification.txt (text/plain, không JSON/HTML): translateme-verify-ab123',
  );
});

test('META instructions provide the tag to add to the home page head', () => {
  assert.equal(
    verificationInstructions('META', 'translateme-verify-ab123', 'https://tenant.example/'),
    'Chèn thẻ sau vào <head> của trang chủ https://tenant.example/: <meta name="translateme-site-verification" content="translateme-verify-ab123">',
  );
});
