import { describe, it, expect, vi } from 'vitest';
import { waitForSubmissionResult, resolveSubmissionPollIntervalMs } from '../../src/panel-flow.mjs';

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

  it('服务端已响应明确失败（conf 页含 認証に失敗）时提前返回 retry，不再空等', async () => {
    const page = makePage({
      text: '認証に失敗しました',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf',
    });
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 2000,
      intervalMs: 10,
    });
    expect(evaluation.status).toBe('retry');
    expect(evaluation.matched).toBe('認証に失敗');
    // 终态提前返回：正文只读取一次
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('业务硬错误（信用卡）持续轮询至超时返回 fail（fail 不提前终止，防中间态误判）', async () => {
    const page = makePage({
      text: 'クレジットカードを登録してください',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/result',
    });
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(evaluation.status).toBe('fail');
    // 提交导航中间态可能瞬时读到 fail「状态不明确」，需持续轮询等最终结果
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(1);
  });

  it('服务端处理中（conf 页无失败标识）持续轮询至超时 → 归一化为 retry', async () => {
    // 2026-08 事故场景：提交后官方处理需 60-90s，期间页面停留 conf；
    // 轮询窗口内未响应时按可重试失败归一化（不再提前中止在途 POST 后误判）
    const page = makePage({
      text: '画像認証 画像にひらがなで書かれている6桁の数字',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf',
    });
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(evaluation.status).toBe('retry');
    expect(evaluation.reason).toContain('页面未跳转');
    // 处理中状态应持续轮询（远多于 1 次），而非读到中间态就立即判定
    expect(page.evaluate.mock.calls.length).toBeGreaterThan(1);
  });

  it('服务端延迟响应（处理中转成功）时轮询命中 success，不再误判失败', async () => {
    // 第二次手动运行对照：提交后 ~72s 才跳转 xvps/index 成功，
    // 轮询期间页面先停留 conf（pending）后跳转成功页
    let reads = 0;
    const page = {
      evaluate: vi.fn().mockImplementation(async () => {
        reads++;
        return reads < 3 ? '画像認証 6桁の数字を入力' : '手続きが完了しました';
      }),
      url: vi
        .fn()
        .mockImplementation(() =>
          reads < 3
            ? 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/conf'
            : 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/result',
        ),
    };
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 2000,
      intervalMs: 10,
    });
    expect(evaluation.status).toBe('success');
    expect(reads).toBe(3);
  });

  it('无 logger 时不报错（默认 NOOP_LOGGER）', async () => {
    const page = makePage({
      text: '更新が完了しました',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/result',
    });
    await expect(waitForSubmissionResult(page, { timeoutMs: 50, intervalMs: 10 })).resolves.toMatchObject({
      evaluation: expect.objectContaining({ status: 'success' }),
    });
  });

  it('未识别成功信号时输出页面正文诊断（debug），便于定位成功文案', async () => {
    // 提交后仍停留在续期域内、正文无已知成功关键词（如跳转中间态）
    const page = makePage({
      text: '契約管理\n引き続き無料VPSの利用を継続する\nホーム',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/do',
    });
    const logger = { debug: vi.fn() };
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 60,
      intervalMs: 10,
      logger,
    });
    expect(evaluation.status).not.toBe('success');
    const diagLines = logger.debug.mock.calls.map((call) => call[0]).filter((line) => line.includes('[提交结果诊断]'));
    // 诊断仅在轮询结束后输出一次
    expect(diagLines).toHaveLength(1);
    expect(diagLines[0]).toContain('URL: https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/do');
    // 正文应归一化空白后输出（换行折叠为空格）
    expect(diagLines[0]).toContain('契約管理 引き続き無料VPSの利用を継続する ホーム');
  });

  it('命中成功信号时不输出正文诊断（仅输出命中日志）', async () => {
    const page = makePage({
      text: '手続きが完了しました',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/server/freevps/extend/result',
    });
    const logger = { debug: vi.fn() };
    await waitForSubmissionResult(page, { timeoutMs: 50, intervalMs: 10, logger });
    const diagLines = logger.debug.mock.calls.map((call) => call[0]).filter((line) => line.includes('[提交结果诊断]'));
    expect(diagLines).toHaveLength(0);
  });

  it('提交后跳回 xvps/index 列表页（正文尚未渲染）→ success', async () => {
    // 本次事故场景：提交成功官方跳回列表页，但跳转期间正文为空
    const page = makePage({
      text: '',
      url: 'https://secure.xserver.ne.jp/xapanel/xvps/index',
    });
    const { evaluation } = await waitForSubmissionResult(page, {
      timeoutMs: 60,
      intervalMs: 10,
    });
    expect(evaluation.status).toBe('success');
    expect(evaluation.matched).toBe('xvps/index');
  });
});

describe('resolveSubmissionPollIntervalMs', () => {
  it('前 10s 密集窗口保持基础间隔（成功信号最常见，灵敏度不变）', () => {
    expect(resolveSubmissionPollIntervalMs(0, 400)).toBe(400);
    expect(resolveSubmissionPollIntervalMs(9_999, 400)).toBe(400);
  });

  it('10s-30s 中期窗口退避到 1s 下限', () => {
    expect(resolveSubmissionPollIntervalMs(10_000, 400)).toBe(1_000);
    expect(resolveSubmissionPollIntervalMs(29_999, 400)).toBe(1_000);
  });

  it('30s 后稀疏窗口退避到 2s 下限（官方处理 60-90s，后期密轮询无收益）', () => {
    expect(resolveSubmissionPollIntervalMs(30_000, 400)).toBe(2_000);
    expect(resolveSubmissionPollIntervalMs(119_000, 400)).toBe(2_000);
  });

  it('基础间隔大于退避下限时保持基础间隔（不退化为更密）', () => {
    expect(resolveSubmissionPollIntervalMs(15_000, 5_000)).toBe(5_000);
    expect(resolveSubmissionPollIntervalMs(60_000, 5_000)).toBe(5_000);
  });

  it('非法入参回退默认 400ms', () => {
    expect(resolveSubmissionPollIntervalMs(Number.NaN, Number.NaN)).toBe(400);
    expect(resolveSubmissionPollIntervalMs(-5, 0)).toBe(400);
  });
});
