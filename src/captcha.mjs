/**
 * 验证码处理模块
 * 负责验证码识别、标准化、平假名转换
 */

/** 验证码标准长度 */
export const CAPTCHA_LENGTH = 6;

/** 预编译的验证码格式正则（避免运行时重复编译） */
export const CAPTCHA_PATTERN = new RegExp(`^\\d{${CAPTCHA_LENGTH}}$`);

/** 平假名到数字的映射表（支持 OCR 错误时的备选匹配） */
export const HIRAGANA_NUMBER_MAP = {
  // 完整平假名
  'ぜろ': '0', 'れい': '0',
  'いち': '1',
  'に': '2',
  'さん': '3',
  'よん': '4', 'し': '4',
  'ご': '5',
  'ろく': '6',
  'なな': '7', 'しち': '7',
  'はち': '8',
  'きゅう': '9', 'く': '9',

  // 可能的片段（OCR 识别错误时的备选）
  'いちご': '15',  // 常见组合
  'さんろく': '36',
  'きゅうろく': '96',
};

/**
 * 尝试将平假名文本转换为数字（支持数字 + 平假名混合内容）
 * @param {string} text - OCR 识别结果
 * @returns {string|null} - 转换后的数字，失败返回 null
 */
export function convertHiraganaToNumber(text) {
  if (!text || /^\d+$/.test(text)) {
    return text;
  }

  // 移除空格和特殊字符
  const cleanText = text.replace(/[\s\-_]/g, '');

  // 方法 1：完整匹配
  if (HIRAGANA_NUMBER_MAP[cleanText]) {
    return HIRAGANA_NUMBER_MAP[cleanText];
  }

  // 方法 2：逐字匹配并拼接（支持混合内容：数字 + 平假名）
  let result = '';
  let i = 0;
  while (i < cleanText.length) {
    let matched = false;

    // 优先检查：如果当前字符已经是数字，直接保留
    if (/^\d$/.test(cleanText[i])) {
      result += cleanText[i];
      i++;
      matched = true;
      continue;
    }

    // 尝试匹配 3 字符、2 字符、1 字符的平假名
    for (let len = 3; len >= 1; len--) {
      const substr = cleanText.substring(i, i + len);
      if (HIRAGANA_NUMBER_MAP[substr]) {
        result += HIRAGANA_NUMBER_MAP[substr];
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      i++;
    }
  }

  if (result.length >= 4) {
    return result;
  }

  return null;
}

/**
 * 统一验证码结果标准化（处理各种 OCR 输出格式）
 * @param {string} rawText - OCR 原始识别结果
 * @returns {string|null} - 标准化后的 6 位纯数字，失败返回 null
 */
export function normalizeCaptchaCode(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }

  // 步骤 1: 基础清理（移除空白和常见分隔符）
  let text = rawText.trim().replace(/[\s\-_]/g, '');

  // 步骤 2: 全角数字转半角
  text = text.replace(/[０-９]/g, (char) => {
    return String.fromCharCode(char.charCodeAt(0) - 0xFEE0);
  });

  // 步骤 3: 如果已经是纯数字，直接返回
  if (CAPTCHA_PATTERN.test(text)) {
    return text;
  }

  // 步骤 4: 尝试平假名转换（支持混合内容：数字 + 平假名）
  const convertedFromHiragana = convertHiraganaToNumber(text);
  if (convertedFromHiragana && CAPTCHA_PATTERN.test(convertedFromHiragana)) {
    return convertedFromHiragana;
  }

  // 步骤 5: 提取所有数字字符（处理混合内容）
  const digitsOnly = text.replace(/\D/g, '');
  if (CAPTCHA_PATTERN.test(digitsOnly)) {
    return digitsOnly;
  }

  // 无法标准化为 6 位数字
  return null;
}

/**
 * 使用 Keras 模型 API 识别验证码（Cloud Run）
 * @param {string} imgBase64 - Base64 编码的图片数据
 * @param {string} apiUrl - Keras API 地址
 * @param {Function} logger - 日志函数
 * @returns {Promise<string>} - 识别的验证码
 */
export async function recognizeCaptchaWithKerasAPI(imgBase64, apiUrl, logger = () => {}) {
  if (!apiUrl) {
    throw new Error('未配置 CAPTCHA_API，无法使用 Keras 模型 API 识别');
  }

  logger(`使用 Keras 模型 API 识别验证码: ${apiUrl}`);

  const captchaController = new AbortController();
  const captchaTimeout = setTimeout(() => captchaController.abort(), 30_000);
  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      body: imgBase64,
      headers: { 'Content-Type': 'text/plain' },
      signal: captchaController.signal,
    });
  } finally {
    clearTimeout(captchaTimeout);
  }

  logger(`Keras 模型 API 响应状态: ${res.status}`);

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Keras 模型 API 响应 ${res.status}: ${errorText}`);
  }

  const rawCode = (await res.text()).trim();
  logger(`Keras 模型 API 返回原始结果: "${rawCode}" (长度: ${rawCode.length})`);

  const code = normalizeCaptchaCode(rawCode);

  if (code) {
    logger(`✅ Keras 模型 API 识别成功: ${code}`);
    return code;
  }

  throw new Error(`Keras 模型 API 返回无效结果: "${rawCode}"`);
}

/**
 * 验证码识别入口（Keras 模型 API）
 * @param {string} imgSrc - Base64 编码的验证码图片（data:image/... 格式）
 * @param {string} apiUrl - Keras API 地址
 * @param {Function} logger - 日志函数
 * @returns {Promise<string>} - 识别的 6 位数字验证码
 */
export async function recognizeCaptcha(imgSrc, apiUrl, logger = () => {}) {
  if (!imgSrc.startsWith('data:image/')) {
    throw new Error('imgSrc 必须是 Base64 格式（data:image/...）');
  }

  if (!apiUrl) {
    throw new Error('未配置 Keras 模型 API（需要 CAPTCHA_API）');
  }

  logger('使用 Keras 模型 API 识别验证码...');

  try {
    const code = await recognizeCaptchaWithKerasAPI(imgSrc, apiUrl, logger);
    logger(`✅ 验证码识别成功: ${code}`);
    return code;
  } catch (error) {
    logger(`❌ Keras 模型 API 识别失败: ${error.message}`);
    throw error;
  }
}
