# Cloudflare Turnstile 技术分析

本文档分析 Cloudflare Turnstile 在自动化环境下的检测机制，以及如何优化 Puppeteer 环境以提升通过率。

---

## 🎯 核心发现

### ✅ 真实浏览器环境下的表现

在真实 Chrome 浏览器中，Cloudflare Turnstile **无需任何用户交互**即可自动通过：

- **通过方式**: 静默验证（Invisible Mode）
- **无需点击**: 没有显示 checkbox
- **通过时间**: 3-15 秒
- **成功率**: >95%

### ❌ Puppeteer 环境的问题

在 Docker + Puppeteer 环境中，Turnstile 几乎无法自动通过：

- **通过方式**: 需要 API 求解
- **通过时间**: 30-60 秒（含 API 轮询）
- **成功率**: ~0%（自动通过）

**差异原因**：浏览器指纹不完整，被识别为自动化环境。

---

## 🔍 Turnstile 检测机制

### 浏览器指纹检测

Cloudflare Turnstile 会收集以下浏览器指纹信息：

#### 1. Navigator 属性
```javascript
{
  userAgent: "Mozilla/5.0 ...",
  platform: "MacIntel",
  language: "zh-CN",
  hardwareConcurrency: 8,      // CPU 核心数
  deviceMemory: 8,             // 设备内存（GB）
  languages: ["zh-CN", "zh", "en"],
  maxTouchPoints: 0
}
```

**常见问题**：
- ❌ `deviceMemory` 缺失（Puppeteer 默认不提供）
- ❌ `hardwareConcurrency` 异常（Docker 容器可能显示 1-2 核）

#### 2. WebGL 渲染器信息
```javascript
const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl');
const renderer = gl.getParameter(gl.UNMASKED_RENDERER_WEBGL);
const vendor = gl.getParameter(gl.UNMASKED_VENDOR_WEBGL);
```

**真实环境示例**：
```
Renderer: Intel Inc. ~ Intel(R) Iris(TM) Plus Graphics 640
Vendor: Intel Inc.
```

**Puppeteer 环境问题**：
- ❌ 渲染器信息显示 "SwiftShader" 或 "ANGLE"（软件渲染）
- ❌ Docker 容器中缺少真实 GPU

#### 3. Canvas 指纹
```javascript
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
ctx.fillText('fingerprint', 10, 10);
const fingerprint = canvas.toDataURL();
```

**问题**：
- ❌ Canvas 渲染结果过于一致（同一环境多次运行结果完全相同）
- ✅ 真实浏览器会有微小差异

#### 4. CDP (Chrome DevTools Protocol) 泄露
```javascript
// Turnstile 可能检测这些特征
window.chrome?.runtime?.connect
window.navigator.webdriver
```

**问题**：
- ❌ Puppeteer 通过 CDP 控制浏览器，可能被检测
- ❌ `navigator.webdriver` 属性存在

---

## 💡 优化方案

### 1. 浏览器指纹补丁

补充缺失的浏览器指纹信息：

```javascript
// browser-fingerprint-patch.js
await page.evaluateOnNewDocument(() => {
  // 补充 deviceMemory
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => 8,
    configurable: true
  });

  // 补充 hardwareConcurrency
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => 8,
    configurable: true
  });

  // 修复 WebGL 渲染器
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) { // RENDERER
      return 'Intel Inc. ~ Intel(R) Iris(TM) Plus Graphics 640';
    }
    if (parameter === 37446) { // VENDOR
      return 'Intel Inc.';
    }
    return getParameter.call(this, parameter);
  };

  // 优化 Canvas 指纹（添加随机噪声）
  const toDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type) {
    if (this.width > 0 && this.height > 0) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imageData.data.length; i += 4) {
          imageData.data[i] += Math.random() > 0.5 ? 1 : -1;
        }
        ctx.putImageData(imageData, 0, 0);
      }
    }
    return toDataURL.apply(this, arguments);
  };

  // 隐藏自动化特征
  delete navigator.__proto__.webdriver;
});
```

### 2. rebrowser-puppeteer

使用 `rebrowser-puppeteer-core` 替代原生 Puppeteer：

```javascript
import { addExtra } from 'puppeteer-extra';
import rebrowserPuppeteer from 'rebrowser-puppeteer-core';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const puppeteer = addExtra(rebrowserPuppeteer);
puppeteer.use(StealthPlugin());
```

**优势**：
- ✅ 修复 CDP Runtime.Enable 泄露
- ✅ 更好的反检测能力

### 3. Stealth 插件

`puppeteer-extra-plugin-stealth` 自动隐藏自动化特征：

- ✅ 删除 `navigator.webdriver`
- ✅ 修复 `window.chrome` 对象
- ✅ 修复 Permissions API
- ✅ 修复 Plugins 和 MimeTypes

### 4. 优化启动参数

```javascript
const chromeArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--window-size=1440,900',  // 常见分辨率
  '--tz=Asia/Shanghai',      // 时区设置
];
```

### 5. User-Agent 优化

使用最新的 Chrome UA：

```javascript
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
await page.setUserAgent(UA);
```

---

## 📊 优化效果对比

| 指标 | 优化前 | 优化后 | 提升 |
|------|--------|--------|------|
| Turnstile 自动通过率 | ~0% | 30-70% | +30-70% |
| 平均续期耗时 | 60-120秒 | 20-40秒 | 2-5倍 |
| API 依赖率 | 100% | 30-70% | -30-70% |

---

## 🔧 Turnstile 双字段处理

### 页面结构发现

Xserver 的 Turnstile 页面中存在**两个** `cf-turnstile-response` 隐藏字段：

```html
<!-- 字段 1：占位符（空值） -->
<input type="hidden" name="cf-turnstile-response" value="">

<!-- 字段 2：实际 token 存储 -->
<input type="hidden" name="cf-turnstile-response" id="cf-chl-widget-xxx_response" value="1.ABC...">
```

### 正确的读取方式

```javascript
// ❌ 错误：只读取第一个字段（可能是空的）
const token = await page.$eval('[name="cf-turnstile-response"]', el => el.value);

// ✅ 正确：读取所有字段，返回第一个有值的
const token = await page.evaluate(() => {
  const fields = document.querySelectorAll('[name="cf-turnstile-response"]');
  for (const field of fields) {
    if (field.value) return field.value;
  }
  return '';
});
```

---

## 🎯 最佳实践

### 1. 优先使用自然通过

```javascript
// 策略 1：点击 Turnstile checkbox 自然通过
await clickTurnstile(page);
const success = await waitForToken(page, 15_000);

if (!success) {
  // 策略 2：API 求解（降级）
  const token = await solveTurnstileAPI(sitekey);
  await injectToken(page, token);
}
```

### 2. 合理配置超时时间

```javascript
const CONFIG = {
  TURNSTILE_TIMEOUT: 60_000,      // 自然通过等待时间
  TURNSTILE_API_TIMEOUT: 120_000, // API 求解超时
};
```

### 3. 使用代理（可选）

如果自动通过率仍然很低，可以配置住宅代理：

```bash
PROXY_TYPE=http
PROXY_ADDRESS=your-proxy-ip
PROXY_PORT=8080
```

**注意**：使用代理时，API 求解也需要使用同一代理，否则 IP 不一致可能导致 token 失效。

---

## 📝 调试技巧

### 1. 查看浏览器指纹

在浏览器控制台运行：

```javascript
console.log({
  deviceMemory: navigator.deviceMemory,
  hardwareConcurrency: navigator.hardwareConcurrency,
  platform: navigator.platform,
  webdriver: navigator.webdriver
});

const canvas = document.createElement('canvas');
const gl = canvas.getContext('webgl');
console.log('Renderer:', gl.getParameter(gl.getParameter(37445)));
```

### 2. 监控 Turnstile 状态

```javascript
// 查看 Turnstile token
document.querySelectorAll('[name="cf-turnstile-response"]').forEach((el, i) => {
  console.log(`字段 ${i}:`, el.value ? '有值' : '空');
});
```

### 3. 截图诊断

```javascript
await page.screenshot({ path: '/tmp/turnstile-state.png' });
```

---

## 🚀 总结

通过以下优化，可以显著提升 Puppeteer 环境下 Turnstile 的自动通过率：

1. ✅ **补充浏览器指纹** - deviceMemory、hardwareConcurrency、WebGL
2. ✅ **使用 rebrowser-puppeteer** - 修复 CDP 泄露
3. ✅ **Stealth 插件** - 隐藏自动化特征
4. ✅ **双字段处理** - 正确读取 Turnstile token
5. ✅ **优化 UA 和参数** - 使用真实环境配置

**预期效果**：
- 自动通过率：30-70%
- 降级 API 求解：30-70%
- 整体成功率：>95%

---

**技术更新日期**: 2026-06-14  
**基于**: Cloudflare Turnstile v0 / Xserver VPS 续期场景
