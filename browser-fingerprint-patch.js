/**
 * 浏览器指纹补丁 - 基于真实 Chrome 环境的指纹数据
 *
 * 通过 Browser Relay 调试收集的真实浏览器指纹：
 * - User Agent: Chrome 149 (Edge)
 * - Platform: MacIntel
 * - Hardware Concurrency: 8
 * - Device Memory: 8 GB
 * - Screen Resolution: 1440x900
 * - Color Depth: 30
 * - Timezone: Asia/Tokyo (Xserver 服务器位于日本)
 *
 * 用途：在 Puppeteer 启动时注入，伪装成真实浏览器环境
 */

/**
 * 在页面加载前注入浏览器指纹补丁
 * @param {Page} page - Puppeteer Page 对象
 */
async function injectBrowserFingerprint(page) {
  await page.evaluateOnNewDocument(() => {
    // ============================================================
    // 1. 补充 navigator.deviceMemory
    // ============================================================
    if (!('deviceMemory' in navigator)) {
      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
        configurable: true,
        enumerable: true
      });
    }

    // ============================================================
    // 2. 确保 navigator.hardwareConcurrency 合理
    // ============================================================
    const realConcurrency = navigator.hardwareConcurrency;
    if (!realConcurrency || realConcurrency < 2) {
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
        configurable: true,
        enumerable: true
      });
    }

    // ============================================================
    // 3. 修复 WebGL 渲染器信息
    // ============================================================
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      // 37445 = UNMASKED_RENDERER_WEBGL
      if (parameter === 37445) {
        return 'Intel Inc. ~ Intel(R) Iris(TM) Plus Graphics 640';
      }
      // 37446 = UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) {
        return 'Intel Inc.';
      }
      return getParameter.call(this, parameter);
    };

    // WebGL2 同样处理
    if (typeof WebGL2RenderingContext !== 'undefined') {
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) {
          return 'Intel Inc. ~ Intel(R) Iris(TM) Plus Graphics 640';
        }
        if (parameter === 37446) {
          return 'Intel Inc.';
        }
        return getParameter2.call(this, parameter);
      };
    }

    // ============================================================
    // 4. 修复 Canvas 指纹
    // ============================================================
    const toDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      // 添加微小的随机噪声，避免 Canvas 指纹过于一致
      if (this.width > 0 && this.height > 0) {
        const ctx = this.getContext('2d');
        if (ctx) {
          const imageData = ctx.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            for (let c = 0; c < 3; c++) {
              const val = imageData.data[i + c];
              if (val > 0 && val < 255) {
                imageData.data[i + c] += Math.random() > 0.5 ? 1 : -1;
              }
            }
          }
          ctx.putImageData(imageData, 0, 0);
        }
      }
      return toDataURL.apply(this, arguments);
    };

    // ============================================================
    // 5. 修复 navigator.plugins 和 mimeTypes
    // ============================================================
    // 真实浏览器通常有一些插件，即使是空的也要有结构
    if (navigator.plugins.length === 0) {
      const mockPlugins = [
        {
          name: 'Chrome PDF Plugin',
          filename: 'internal-pdf-viewer',
          description: 'Portable Document Format',
          length: 1,
          item: () => null,
          namedItem: () => null
        },
        {
          name: 'Chrome PDF Viewer',
          filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',
          description: '',
          length: 1,
          item: () => null,
          namedItem: () => null
        }
      ];

      Object.defineProperty(navigator, 'plugins', {
        get: () => mockPlugins,
        configurable: true,
        enumerable: true
      });
    }

    // ============================================================
    // 6. 修复 navigator.languages
    // ============================================================
    if (!navigator.languages || navigator.languages.length === 0) {
      Object.defineProperty(navigator, 'languages', {
        get: () => ['ja', 'ja-JP', 'en-US', 'en'],
        configurable: true,
        enumerable: true
      });
    }

    // ============================================================
    // 7. 修复 screen.colorDepth
    // ============================================================
    // 确保颜色深度合理（24 或 30）
    if (screen.colorDepth !== 24 && screen.colorDepth !== 30) {
      Object.defineProperty(screen, 'colorDepth', {
        get: () => 24,
        configurable: true,
        enumerable: true
      });
    }

    // ============================================================
    // 8. 添加 Connection API（可选）
    // ============================================================
    if (!navigator.connection) {
      Object.defineProperty(navigator, 'connection', {
        get: () => ({
          effectiveType: '4g',
          downlink: 10,
          rtt: 50,
          saveData: false
        }),
        configurable: true,
        enumerable: true
      });
    }

    // ============================================================
    // 9. 修复 Permissions API
    // ============================================================
    // 确保 Permissions API 正常工作
    if (navigator.permissions && navigator.permissions.query) {
      const originalQuery = navigator.permissions.query;
      navigator.permissions.query = function(parameters) {
        // 对于某些权限，返回合理的默认值
        if (parameters.name === 'notifications') {
          return Promise.resolve({ state: 'prompt' });
        }
        return originalQuery.apply(this, arguments);
      };
    }

    // ============================================================
    // 10. 隐藏自动化特征
    // ============================================================
    // 删除 navigator.webdriver（Stealth 插件已处理，这里加强）
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
      configurable: true,
    });

    // 修复 chrome.runtime（有些检测会查找扩展 API）
    if (window.chrome && !window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  });
}

export { injectBrowserFingerprint };
