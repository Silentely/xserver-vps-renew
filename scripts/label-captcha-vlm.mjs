#!/usr/bin/env node

/**
 * 验证码视觉大模型（VLM）自动批量打标工具
 * 
 * 功能：
 * 批量读取未标注/识别失败的验证码图片，调用视觉大模型（Gemini / OpenAI 兼容接口 / Qwen-VL 等）
 * 进行高精度平假名/字符识别，并将图片自动重命名/规整移动到标注完成目录，供模型训练使用。
 * 
 * 零额外 npm 依赖，Node 18+ 内置 fetch 直接运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPT = 'This image contains a Japanese CAPTCHA. It typically consists of Japanese hiragana characters (or digits). Recognize the characters accurately from left to right. Return ONLY the recognized characters without any spaces, newlines, markdown codeblocks, punctuation, or explanation.';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    input: process.env.CAPTCHA_INPUT_DIR || 'dataset/unlabeled',
    output: process.env.CAPTCHA_OUTPUT_DIR || 'dataset/labeled',
    provider: process.env.VLM_PROVIDER || '', // 'gemini' | 'openai'
    apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || '',
    apiBase: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
    model: process.env.VLM_MODEL || '',
    dryRun: false,
    copy: false,
    delayMs: 600,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--input' && args[i + 1]) options.input = args[++i];
    else if (arg === '--output' && args[i + 1]) options.output = args[++i];
    else if (arg === '--provider' && args[i + 1]) options.provider = args[++i];
    else if (arg === '--api-key' && args[i + 1]) options.apiKey = args[++i];
    else if (arg === '--api-base' && args[i + 1]) options.apiBase = args[++i];
    else if (arg === '--model' && args[i + 1]) options.model = args[++i];
    else if (arg === '--delay' && args[i + 1]) options.delayMs = Number(args[++i]) || 600;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--copy') options.copy = true;
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  // 自动推断与规范化 provider
  if (!options.provider) {
    if (process.env.GEMINI_API_KEY) {
      options.provider = 'gemini';
      if (!options.model) options.model = 'gemini-1.5-flash';
    } else if (process.env.OPENAI_API_KEY) {
      options.provider = 'openai';
      if (!options.model) options.model = 'gpt-4o-mini';
    } else {
      options.provider = 'gemini';
      if (!options.model) options.model = 'gemini-1.5-flash';
    }
  } else {
    options.provider = options.provider.toLowerCase().trim();
    if (!['gemini', 'openai'].includes(options.provider)) {
      console.error(`❌ 错误: 无效的 --provider "${options.provider}"。仅支持 "gemini" 或 "openai"。`);
      process.exit(1);
    }
    if (!options.model) {
      options.model = options.provider === 'gemini' ? 'gemini-1.5-flash' : 'gpt-4o-mini';
    }
  }

  return options;
}

function printHelp() {
  console.log(`
使用方式:
  node scripts/label-captcha-vlm.mjs [选项]

常用选项:
  --input <dir>       待打标图片目录（默认: dataset/unlabeled）
  --output <dir>      打标完成输出目录（默认: dataset/labeled）
  --provider <name>   视觉模型提供商: gemini (默认) 或 openai
  --api-key <key>     API 密钥（或通过 GEMINI_API_KEY / OPENAI_API_KEY 环境变量提供）
  --api-base <url>    OpenAI 兼容接口 Base URL（默认: https://api.openai.com/v1）
  --model <name>      使用的模型名（Gemini 默认 gemini-1.5-flash；OpenAI 默认 gpt-4o-mini）
  --delay <ms>        请求间隔毫秒（默认: 600）
  --dry-run           仅输出识别预览结果，不移动/重命名文件
  --copy              复制文件到输出目录（默认是移动文件）

示例:
  # 使用 Google Gemini 打标
  GEMINI_API_KEY="AIzaSy..." node scripts/label-captcha-vlm.mjs

  # 使用 OpenAI 兼容接口（例如千问 Qwen-VL / 智谱 / DeepSeek 等）
  node scripts/label-captcha-vlm.mjs \\
    --provider openai \\
    --api-base https://dashscope.aliyuncs.com/compatible-mode/v1 \\
    --api-key "sk-..." \\
    --model qwen-vl-plus
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

async function callGemini(base64Data, mimeType, { apiKey, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = {
    contents: [
      {
        parts: [
          { text: PROMPT },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 30,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Gemini API HTTP ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text.trim();
}

async function callOpenAICompatible(base64Data, mimeType, { apiKey, apiBase, model }) {
  const endpoint = apiBase.replace(/\/+$/, '') + '/chat/completions';
  const dataUri = `data:${mimeType};base64,${base64Data}`;
  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          {
            type: 'image_url',
            image_url: { url: dataUri },
          },
        ],
      },
    ],
    temperature: 0.0,
    max_tokens: 30,
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`OpenAI API HTTP ${res.status}: ${errorText}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  return text.trim();
}

function cleanLabel(rawText) {
  if (!rawText) return '';
  // 清洗掉可能的 markdown 代码块标识、换行、空格和常见标点
  let text = rawText
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/[\r\n\t]/g, '')
    .trim();

  // 提取有效字符（假名、数字、英文字符）
  text = text.replace(/[^0-9a-zA-Z\u3040-\u309F\u30A0-\u30FF]/g, '');
  return text;
}

async function main() {
  const opts = parseArgs();

  if (!opts.apiKey) {
    console.error('❌ 错误: 未提供 API Key。请通过 --api-key 或环境变量 (GEMINI_API_KEY / OPENAI_API_KEY) 设置。');
    process.exit(1);
  }

  const inputDir = path.resolve(opts.input);
  const outputDir = path.resolve(opts.output);

  if (!fs.existsSync(inputDir)) {
    console.error(`❌ 输入目录不存在: ${inputDir}`);
    process.exit(1);
  }

  if (!opts.dryRun) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const allFiles = fs.readdirSync(inputDir);
  const imageFiles = allFiles.filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));

  if (imageFiles.length === 0) {
    console.log(`ℹ️ 输入目录 (${inputDir}) 中暂无待打标的图片文件。`);
    process.exit(0);
  }

  console.log(`🚀 开始批量打标任务 | 发现图片: ${imageFiles.length} 张`);
  console.log(`📌 模型: [${opts.provider}] ${opts.model} | 模式: ${opts.dryRun ? '预览 (Dry-Run)' : (opts.copy ? '复制' : '移动')}`);
  console.log(`📂 输入: ${inputDir}`);
  console.log(`📂 输出: ${outputDir}\n`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const filename = imageFiles[i];
    const filePath = path.join(inputDir, filename);
    const progress = `[${i + 1}/${imageFiles.length}]`;

    try {
      const mimeType = getMimeType(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const base64Data = fileBuffer.toString('base64');

      let rawResult = '';
      if (opts.provider === 'openai') {
        rawResult = await callOpenAICompatible(base64Data, mimeType, opts);
      } else {
        rawResult = await callGemini(base64Data, mimeType, opts);
      }

      const label = cleanLabel(rawResult);

      if (!label || label.length < 4 || label.length > 7) {
        console.warn(`⚠️ ${progress} 识别结果疑似异常: "${rawResult}" (清洗后: "${label}") | 文件: ${filename}，跳过`);
        failCount++;
        continue;
      }

      const ext = path.extname(filename);
      const randSuffix = Math.random().toString(36).slice(2, 6);
      const newFilename = `${label}_${Date.now()}_${randSuffix}${ext}`;
      const destPath = path.join(outputDir, newFilename);

      if (opts.dryRun) {
        console.log(`🔍 ${progress} [预览] ${filename} -> 识别为: "${label}" -> 拟保存为: ${newFilename}`);
      } else {
        if (opts.copy) {
          fs.copyFileSync(filePath, destPath);
        } else {
          fs.renameSync(filePath, destPath);
        }
        console.log(`✅ ${progress} ${filename} -> "${label}" -> ${newFilename}`);
      }

      successCount++;
    } catch (err) {
      console.error(`❌ ${progress} 处理 ${filename} 失败: ${err.message}`);
      failCount++;
    }

    if (i < imageFiles.length - 1 && opts.delayMs > 0) {
      await sleep(opts.delayMs);
    }
  }

  console.log(`\n🎉 打标完成！成功: ${successCount}，跳过/失败: ${failCount}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
