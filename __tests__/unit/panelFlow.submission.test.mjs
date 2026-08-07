import { describe, it, expect, vi } from 'vitest';
import { waitForSubmissionResult } from '../../src/panel-flow.mjs';

/** 构造最小 page 桩：evaluate 返回正文，url 返回当前地址 */
function makePage({ text, url }) {
  return {
    evaluate: vi.fn().mockResolvedValue(text),
    url: vi.fn().mockReturnValue(url),
  };
}

describe('waitForSubmissionResult', () => {
  it('首次读取即命中成功信号时提前返回，不再继续轮询', async () => {
    const page = makePage({
      text: '手続きが完了しました',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/result',
    });
    const { evaluation, pageText } = await waitForSubmissionResult(page, {
      timeoutMs: 2000,
      intervalMs: 400,
    });
    expect(evaluation.status).toBe('success');
    expect(pageText).toBe('手続きが完了しました');
    // 成功立即返回：正文只读取一次
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('始终停留在 conf 页（retry）时轮询至超时，返回最后一次评估', async () => {
    const page = makePage({
      text: '認証に失敗しました',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf',
    });
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(evaluation.status).toBe('retry');
    // 未命中成功信号：应轮询多次（远多于 1 次）
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(1);
  });

  it('失败标识但未命中成功信号时同样等待至超时，避免过早误判', async () => {
    const page = makePage({
      text: 'クレジットカードを登録してください',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/result',
    });
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(evaluation.status).toBe('fail');
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(1);
  });

  it('无 logger 时不报错（默认 NOOP_LOGGER）', async () => {
    const page = makePage({
      text: '更新が完了しました',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/result',
    });
    await expect(waitForSubmissionResult(page, { timeoutMs: 50, intervalMs: 10 }))
      .resolves.toMatchObject({ evaluation: expect.objectContaining({ status: 'success' }) });
  });
});
