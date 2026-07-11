import { describe, it, expect } from 'vitest';
import { convertHiraganaToNumber } from '../../src/captcha.mjs';

describe('convertHiraganaToNumber', () => {
  it('converts single hiragana digits', () => {
    expect(convertHiraganaToNumber('いち')).toBe('1');
    expect(convertHiraganaToNumber('に')).toBe('2');
    expect(convertHiraganaToNumber('ご')).toBe('5');
  });

  it('converts multi-char hiragana digits', () => {
    expect(convertHiraganaToNumber('ぜろ')).toBe('0');
    expect(convertHiraganaToNumber('きゅう')).toBe('9');
    expect(convertHiraganaToNumber('ろく')).toBe('6');
  });

  it('handles combo entries', () => {
    expect(convertHiraganaToNumber('いちご')).toBe('15');
  });

  it('returns pure-digit input unchanged', () => {
    expect(convertHiraganaToNumber('123456')).toBe('123456');
  });

  it('returns null for empty or non-string input', () => {
    expect(convertHiraganaToNumber('')).toBeNull();
    expect(convertHiraganaToNumber(null)).toBeNull();
    expect(convertHiraganaToNumber(undefined)).toBeNull();
  });

  it('skips unmappable characters', () => {
    // 'X' is unmappable (skipped), 'いち' → '1', 'に' → '2'
    // Result is '12' (length 2, < 4), so returns null per the >= 4 check
    expect(convertHiraganaToNumber('Xいちに')).toBeNull();
  });

  it('returns null when result too short', () => {
    expect(convertHiraganaToNumber('よ')).toBeNull();
  });
});
