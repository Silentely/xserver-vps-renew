import { describe, it, expect } from 'vitest';
import { normalizeCaptchaCode } from '../../xserver-vps-renew.mjs';

describe('normalizeCaptchaCode', () => {
  it('returns 6-digit string unchanged', () => {
    expect(normalizeCaptchaCode('123456')).toBe('123456');
  });

  it('converts fullwidth digits to halfwidth', () => {
    expect(normalizeCaptchaCode('１２３４５６')).toBe('123456');
  });

  it('strips whitespace and separators', () => {
    expect(normalizeCaptchaCode('123-456')).toBe('123456');
    expect(normalizeCaptchaCode(' 123 456 ')).toBe('123456');
  });

  it('extracts digits from mixed content', () => {
    expect(normalizeCaptchaCode('a1b2c3d4e5f6')).toBe('123456');
  });

  it('returns null for null/undefined/empty input', () => {
    expect(normalizeCaptchaCode(null)).toBeNull();
    expect(normalizeCaptchaCode('')).toBeNull();
    expect(normalizeCaptchaCode(undefined)).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(normalizeCaptchaCode(123456)).toBeNull();
  });

  it('returns null when result is not 6 digits', () => {
    expect(normalizeCaptchaCode('12345')).toBeNull();
    expect(normalizeCaptchaCode('1234567')).toBeNull();
    expect(normalizeCaptchaCode('abcdef')).toBeNull();
  });

  it('handles hiragana digits', () => {
    expect(normalizeCaptchaCode('いちにさんよんごろく')).toBe('123456');
  });

  it('handles mixed digit + hiragana', () => {
    expect(normalizeCaptchaCode('12さん456')).toBe('123456');
  });
});
