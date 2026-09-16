import { describe, it, expect, vi } from 'vitest';
import { syncRenewalFormFields } from '../../src/panel-flow.mjs';

describe('syncRenewalFormFields', () => {
  it('同步多个 auth_code 输入框（包括 hidden 和 text），分发 input/change 事件', async () => {
    let evaluateFn;
    const page = {
      evaluate: vi.fn().mockImplementation((fn, args) => {
        evaluateFn = fn;
        // 模拟页面 DOM
        const formElements = [
          { name: 'uniqid', type: 'hidden', value: 'uid123' },
          { name: 'id_vps', type: 'hidden', value: '40091511' },
          { name: 'auth_code', type: 'hidden', value: '' },
          { name: 'cf-turnstile-response', type: 'hidden', value: '' },
          { name: 'auth_code', type: 'text', value: '123456' },
          { name: 'cf-turnstile-response', type: 'hidden', value: 'token_abc' },
        ];

        // 模拟 evaluate 回调逻辑
        return evaluateFn(args);
      }),
    };

    // 使用模拟 DOM 的 evaluate
    const mockEvaluatePage = {
      evaluate: vi.fn().mockImplementation(async (fn, args) => {
        // 创建最小 mock DOM 环境
        const authHidden = { name: 'auth_code', type: 'hidden', value: '', events: [], dispatchEvent(e) { this.events.push(e.type); } };
        const authText = { name: 'auth_code', type: 'text', value: '', events: [], dispatchEvent(e) { this.events.push(e.type); } };
        const tsHidden1 = { name: 'cf-turnstile-response', type: 'hidden', value: '', events: [], dispatchEvent(e) { this.events.push(e.type); } };
        const tsHidden2 = { name: 'cf-turnstile-response', type: 'hidden', value: '', events: [], dispatchEvent(e) { this.events.push(e.type); } };

        const form = {
          elements: [
            { name: 'uniqid', type: 'hidden', value: 'abc' },
            authHidden,
            tsHidden1,
            authText,
            tsHidden2,
          ],
        };

        const doc = {
          querySelectorAll: (sel) => {
            if (sel.includes('auth_code')) return [authHidden, authText];
            if (sel.includes('cf-turnstile-response')) return [tsHidden1, tsHidden2];
            return [];
          },
          querySelector: (sel) => {
            if (sel === 'form') return form;
            return null;
          },
        };

        // 在 mock 上下文下执行
        const prevDoc = globalThis.document;
        const prevEvent = globalThis.Event;
        globalThis.document = doc;
        globalThis.Event = class { constructor(type) { this.type = type; } };

        try {
          return await fn(args);
        } finally {
          globalThis.document = prevDoc;
          globalThis.Event = prevEvent;
        }
      }),
    };

    const res = await syncRenewalFormFields(mockEvaluatePage, { code: '651633', token: 'cf_tok_123' });

    expect(res.authCodeCount).toBe(2);
    expect(res.authCodeUpdated).toBe(2);
    expect(res.turnstileCount).toBe(2);
    expect(res.turnstileUpdated).toBe(2);
    expect(res.formFields.length).toBe(5);
    expect(res.formFields.filter((f) => f.name === 'auth_code')).toHaveLength(2);
    expect(res.formFields.filter((f) => f.name === 'cf-turnstile-response')).toHaveLength(2);
  });

  it('仅传入 code 时只同步 auth_code，不修改 turnstile 字段', async () => {
    const mockEvaluatePage = {
      evaluate: vi.fn().mockImplementation(async (fn, args) => {
        const authHidden = { name: 'auth_code', type: 'hidden', value: '', dispatchEvent: vi.fn() };
        const tsHidden = { name: 'cf-turnstile-response', type: 'hidden', value: 'existing_token', dispatchEvent: vi.fn() };

        const prevDoc = globalThis.document;
        const prevEvent = globalThis.Event;
        globalThis.document = {
          querySelectorAll: (sel) => {
            if (sel.includes('auth_code')) return [authHidden];
            if (sel.includes('cf-turnstile-response')) return [tsHidden];
            return [];
          },
          querySelector: () => ({ elements: [authHidden, tsHidden] }),
        };
        globalThis.Event = class { constructor(type) { this.type = type; } };

        try {
          return await fn(args);
        } finally {
          globalThis.document = prevDoc;
          globalThis.Event = prevEvent;
        }
      }),
    };

    const res = await syncRenewalFormFields(mockEvaluatePage, { code: '998877' });
    expect(res.authCodeCount).toBe(1);
    expect(res.turnstileCount).toBe(0);
    expect(res.turnstileUpdated).toBe(0);
  });

  it('页面无表单或无对应元素时优雅返回默认统计，不抛出异常', async () => {
    const mockEmptyPage = {
      evaluate: vi.fn().mockImplementation(async (fn, args) => {
        const prevDoc = globalThis.document;
        const prevEvent = globalThis.Event;
        globalThis.document = {
          querySelectorAll: () => [],
          querySelector: () => null,
        };
        globalThis.Event = class { constructor(type) { this.type = type; } };

        try {
          return await fn(args);
        } finally {
          globalThis.document = prevDoc;
          globalThis.Event = prevEvent;
        }
      }),
    };

    const res = await syncRenewalFormFields(mockEmptyPage, { code: '123456' });
    expect(res.authCodeCount).toBe(0);
    expect(res.turnstileCount).toBe(0);
    expect(res.formFields).toEqual([]);
  });

  it('page.evaluate 发生网络/导航异常时安全降级，返回空结果而不崩溃', async () => {
    const brokenPage = {
      evaluate: vi.fn().mockRejectedValue(new Error('Execution context was destroyed')),
    };

    const res = await syncRenewalFormFields(brokenPage, { code: '123456' });
    expect(res.authCodeCount).toBe(0);
    expect(res.turnstileCount).toBe(0);
    expect(res.formFields).toEqual([]);
  });
});
