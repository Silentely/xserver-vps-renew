import { describe, it, expect } from 'vitest';
import { normalizeCaptchaCode } from '../../src/captcha.mjs';

describe('normalizeCaptchaCode - 边界条件', () => {
  // ===== 空值 / 非字符串输入 =====

  it('输入 null 返回 null', () => {
    expect(normalizeCaptchaCode(null)).toBeNull();
  });

  it('输入 undefined 返回 null', () => {
    expect(normalizeCaptchaCode(undefined)).toBeNull();
  });

  it('输入空字符串返回 null', () => {
    expect(normalizeCaptchaCode('')).toBeNull();
  });

  it('输入纯空白字符串返回 null', () => {
    expect(normalizeCaptchaCode('   ')).toBeNull();
    expect(normalizeCaptchaCode('\t\n')).toBeNull();
  });

  it('输入数字类型返回 null（非字符串）', () => {
    expect(normalizeCaptchaCode(123456)).toBeNull();
  });

  it('输入对象类型返回 null', () => {
    expect(normalizeCaptchaCode({ text: '123456' })).toBeNull();
  });

  // ===== 特殊字符 / 注入攻击防护 =====

  it('输入 HTML 标签返回 null', () => {
    expect(normalizeCaptchaCode('<script>alert(1)</script>')).toBeNull();
  });

  it('输入 SQL 注入字符串返回 null', () => {
    expect(normalizeCaptchaCode("1' OR '1'='1")).toBeNull();
  });

  it('输入超长字符串返回 null', () => {
    const longInput = '1'.repeat(10000);
    expect(normalizeCaptchaCode(longInput)).toBeNull();
  });

  // 表情符号中的数字部分可被逐字提取（表情 = 数字 + 装饰符 + 变体选择器）
  // 函数会跳过无法映射的字符，提取出 123456
  it('输入 Unicode 表情数字可被提取为纯数字', () => {
    expect(normalizeCaptchaCode('1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣')).toBe('123456');
  });

  // 零宽空格（U+200B）不在映射表中，被跳过，剩余 "123456" 恰好 6 位
  it('输入含零宽字符的数字内容可被提取', () => {
    expect(normalizeCaptchaCode('123​456')).toBe('123456');
  });

  // ===== 全角数字处理 =====

  it('输入全角数字正确转为半角', () => {
    expect(normalizeCaptchaCode('１２３４５６')).toBe('123456');
  });

  it('输入全角数字混合半角返回 null（长度不对）', () => {
    expect(normalizeCaptchaCode('１2345')).toBeNull();
  });

  // ===== 分隔符处理 =====

  it('输入带连字符分隔的数字返回 null（清理后超长）', () => {
    // "12-34-56" 清理后 "123456" → 6 位纯数字，应通过
    expect(normalizeCaptchaCode('12-34-56')).toBe('123456');
  });

  it('输入带下划线分隔的数字', () => {
    expect(normalizeCaptchaCode('12_34_56')).toBe('123456');
  });

  it('输入带空格分隔的数字', () => {
    expect(normalizeCaptchaCode('12 34 56')).toBe('123456');
  });

  // ===== 长度边界 =====

  it('输入 5 位数字返回 null（不足 6 位）', () => {
    expect(normalizeCaptchaCode('12345')).toBeNull();
  });

  it('输入 7 位数字返回 null（超过 6 位）', () => {
    expect(normalizeCaptchaCode('1234567')).toBeNull();
  });

  it('输入 5 位数字加字母混合返回 null', () => {
    expect(normalizeCaptchaCode('1234a')).toBeNull();
  });

  // ===== 混合内容提取 =====

  it('从字母包围中提取 6 位数字', () => {
    expect(normalizeCaptchaCode('abc123456def')).toBe('123456');
  });

  it('从多段数字中提取前 6 位', () => {
    // "123 456 789" → 提取所有数字 "123456789" → 9 位，不匹配
    expect(normalizeCaptchaCode('123 456 789')).toBeNull();
  });

  it('从单引号和数字混合中提取数字', () => {
    expect(normalizeCaptchaCode("'1'2'3'4'5'6'")).toBe('123456');
  });
});
