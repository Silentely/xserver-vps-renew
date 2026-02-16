/**
 * 修复 CDP Input.dispatchMouseEvent 导致的 MouseEvent.screenX/screenY 异常
 *
 * 问题根因（Chromium bug #40280325）：
 *   CDP 产生的 MouseEvent 的 screenX/screenY 等于 clientX/clientY，
 *   而非真实屏幕坐标。Cloudflare Turnstile 通过检测这个差异判定自动化。
 *
 * 修复策略：
 *   重写 MouseEvent.prototype 的 screenX/screenY getter，
 *   当检测到可疑值时，用 window.screenX + clientX 计算真实屏幕坐标。
 *
 * 关键配置（manifest.json）：
 *   - "all_frames": true  — 注入到所有 frame，包括 Turnstile OOPIF
 *   - "world": "MAIN"     — 注入到主世界，才能修改页面可见的 MouseEvent.prototype
 *   - "run_at": "document_start" — 在 Turnstile 脚本执行前完成修补
 */
(function () {
  'use strict';

  // 保存原始的属性描述符
  const origScreenXDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenX');
  const origScreenYDesc = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'screenY');

  if (!origScreenXDesc || !origScreenXDesc.get) return;

  // 用 WeakMap 缓存每个事件实例的修复后值，避免重复计算
  const cache = new WeakMap();

  /**
   * 计算修正后的屏幕坐标
   * 真实鼠标事件：screenX = 窗口在屏幕上的位置 + 元素在视口中的位置
   * CDP 鼠标事件：screenX 错误地等于 clientX（相对视口）
   */
  function getPatchedCoords(event) {
    if (cache.has(event)) return cache.get(event);

    const clientX = event.clientX || 0;
    const clientY = event.clientY || 0;

    // window.screenX/screenY 是浏览器窗口在屏幕上的位置
    let realScreenX = clientX + (window.screenX || 0);
    let realScreenY = clientY + (window.screenY || 0);

    // 微量随机抖动（+/-1px），模拟真实硬件的微小偏差
    realScreenX += Math.floor(Math.random() * 3) - 1;
    realScreenY += Math.floor(Math.random() * 3) - 1;

    const result = { screenX: realScreenX, screenY: realScreenY };
    cache.set(event, result);
    return result;
  }

  /**
   * 判断原始 screenX/screenY 是否为 CDP 产生的可疑值
   * 可疑特征：
   *   - screenX === clientX（CDP 直接复制了 clientX 的值）
   *   - screenX === 0（某些 headless 环境下的默认值）
   */
  function isSuspicious(origValue, clientValue) {
    return origValue === 0 || origValue === clientValue;
  }

  Object.defineProperties(MouseEvent.prototype, {
    screenX: {
      configurable: true,
      enumerable: true,
      get() {
        const orig = origScreenXDesc.get.call(this);
        if (isSuspicious(orig, this.clientX)) {
          return getPatchedCoords(this).screenX;
        }
        return orig;
      },
    },
    screenY: {
      configurable: true,
      enumerable: true,
      get() {
        const orig = origScreenYDesc.get.call(this);
        if (isSuspicious(orig, this.clientY)) {
          return getPatchedCoords(this).screenY;
        }
        return orig;
      },
    },
  });
})();
