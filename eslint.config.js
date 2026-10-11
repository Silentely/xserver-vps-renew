import js from '@eslint/js';
import globals from 'globals';
import importPlugin from 'eslint-plugin-import';
import n from 'eslint-plugin-n';

/** 浏览器上下文文件（指纹注入 / 扩展内容脚本 / 用户脚本），使用浏览器全局 */
const BROWSER_FILES = ['browser-fingerprint-patch.js', 'turnstile-patch/**/*.js', 'xserver-renews.js'];

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'memory/**',
      'logs/**',
      'data/**',
      'chrome-profile/**',
      'assets/**',
      'package-lock.json',
      '**/*.md',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: {
      import: importPlugin,
      n,
    },
    rules: {
      // 导入分组顺序：builtin → external → parent → sibling；
      // 不强制组间空行（保留各模块注释段分组的既有习惯），也不开组内字母序
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'ignore',
        },
      ],
      'n/no-missing-import': 'error',
      // 命名规范：变量/函数 camelCase（全大写常量不受影响），构造函数 PascalCase；
      // 油猴 API 名不可改名，列入白名单
      camelcase: ['error', { properties: 'never', allow: ['GM_registerMenuCommand'] }],
      'new-cap': ['error', { capIsNew: false }],
      // 未使用变量/参数：允许 _ 前缀占位
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
        },
      ],
      'no-console': 'off',
    },
  },
  {
    // src 模块内 page.evaluate 的回调在浏览器上下文执行，引用下列全局属于预期行为
    files: ['src/page-utils.mjs', 'src/panel-flow.mjs', 'src/turnstile-flow.mjs', 'src/turnstile.mjs'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
      },
    },
  },
  {
    files: BROWSER_FILES,
    languageOptions: {
      globals: {
        ...globals.browser,
        $: 'readonly',
        chrome: 'readonly',
        unsafeWindow: 'readonly',
        GM_getValue: 'readonly',
        GM_setValue: 'readonly',
        GM_registerMenuCommand: 'readonly',
        GM_addStyle: 'readonly',
      },
    },
  },
];
