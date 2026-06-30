import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../xserver-vps-renew.mjs';

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes multiple special chars', () => {
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('does not modify safe strings', () => {
    expect(escapeHtml('host123')).toBe('host123');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("a'b")).toBe('a&#39;b');
  });

  it('escapes all HTML special chars together', () => {
    expect(escapeHtml('<a href="x">\'y\'</a>'))
      .toBe('&lt;a href=&quot;x&quot;&gt;&#39;y&#39;&lt;/a&gt;');
  });
});
