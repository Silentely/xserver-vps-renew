#!/usr/bin/env python3
"""
验证码视觉大模型（VLM）自动批量打标工具 (Python 3 零第三方依赖版本)

功能：
批量读取未标注/识别失败的验证码图片，调用视觉大模型（Gemini / OpenAI 兼容接口）
进行高精度日文平假名/验证码字符识别，并将图片自动重命名/归档到 labeled 目录。
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

PROMPT = (
    "This image contains a Japanese CAPTCHA. It typically consists of Japanese hiragana characters "
    "(or digits). Recognize the characters accurately from left to right. Return ONLY the recognized "
    "characters without any spaces, newlines, markdown codeblocks, punctuation, or explanation."
)


def parse_args():
    parser = argparse.ArgumentParser(description="验证码视觉大模型 (VLM) 自动打标工具")
    parser.add_argument(
        "--input",
        default=os.getenv("CAPTCHA_INPUT_DIR", "dataset/unlabeled"),
        help="待打标图片目录 (默认: dataset/unlabeled)",
    )
    parser.add_argument(
        "--output",
        default=os.getenv("CAPTCHA_OUTPUT_DIR", "dataset/labeled"),
        help="打标完成输出目录 (默认: dataset/labeled)",
    )
    parser.add_argument(
        "--provider",
        choices=["gemini", "openai"],
        default=os.getenv("VLM_PROVIDER", ""),
        help="模型提供商: gemini 或 openai",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY") or "",
        help="API 密钥 (或通过 GEMINI_API_KEY / OPENAI_API_KEY 提供)",
    )
    parser.add_argument(
        "--api-base",
        default=os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1"),
        help="OpenAI 兼容接口 Base URL",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("VLM_MODEL", ""),
        help="模型名称 (Gemini 默认 gemini-1.5-flash; OpenAI 默认 gpt-4o-mini)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=0.6,
        help="请求间隔秒数 (默认 0.6)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="仅预览识别结果，不移动/修改文件",
    )
    parser.add_argument(
        "--copy",
        action="store_true",
        help="复制文件到输出目录 (默认移动)",
    )
    return parser.parse_args()


def call_gemini(b64_data: str, mime_type: str, api_key: str, model: str) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(api_key)}"
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": PROMPT},
                    {"inline_data": {"mime_type": mime_type, "data": b64_data}},
                ]
            }
        ],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 30},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        res_data = json.loads(resp.read().decode("utf-8"))
        return res_data["candidates"][0]["content"]["parts"][0]["text"].strip()


def call_openai(b64_data: str, mime_type: str, api_key: str, api_base: str, model: str) -> str:
    url = f"{api_base.rstrip('/')}/chat/completions"
    data_uri = f"data:{mime_type};base64,{b64_data}"
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {"type": "image_url", "image_url": {"url": data_uri}},
                ],
            }
        ],
        "temperature": 0.0,
        "max_tokens": 30,
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        res_data = json.loads(resp.read().decode("utf-8"))
        return res_data["choices"][0]["message"]["content"].strip()


def clean_label(raw: str) -> str:
    if not raw:
        return ""
    text = re.sub(r"```[a-zA-Z]*", "", raw)
    text = text.replace("```", "").strip()
    # 提取假名、数字与字母
    clean = re.sub(r"[^0-9a-zA-Z\u3040-\u309F\u30A0-\u30FF]", "", text)
    return clean


def main():
    args = parse_args()

    provider = args.provider
    if not provider:
        if os.getenv("GEMINI_API_KEY"):
            provider = "gemini"
        elif os.getenv("OPENAI_API_KEY"):
            provider = "openai"
        else:
            provider = "gemini"

    model = args.model
    if not model:
        model = "gemini-1.5-flash" if provider == "gemini" else "gpt-4o-mini"

    if not args.api_key:
        print("❌ 错误: 未提供 API Key。请指定 --api-key 或设置环境变量 GEMINI_API_KEY / OPENAI_API_KEY", file=sys.stderr)
        sys.exit(1)

    input_dir = os.path.abspath(args.input)
    output_dir = os.path.abspath(args.output)

    if not os.path.isdir(input_dir):
        print(f"❌ 输入目录不存在: {input_dir}", file=sys.stderr)
        sys.exit(1)

    if not args.dry_run:
        os.makedirs(output_dir, exist_ok=True)

    images = [f for f in os.listdir(input_dir) if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
    if not images:
        print(f"ℹ️ 输入目录 ({input_dir}) 中未找到图片。")
        return

    print(f"🚀 开始批量打标 | 图片总数: {len(images)}")
    print(f"📌 提供商: [{provider}] {model} | 模式: {'预览 (Dry-Run)' if args.dry_run else ('复制' if args.copy else '移动')}")
    print(f"📂 输入: {input_dir}")
    print(f"📂 输出: {output_dir}\n")

    success_cnt = 0
    fail_cnt = 0

    for i, fname in enumerate(images):
        fpath = os.path.join(input_dir, fname)
        progress = f"[{i + 1}/{len(images)}]"

        try:
            mime_type, _ = mimetypes.guess_type(fpath)
            mime_type = mime_type or "image/png"

            with open(fpath, "rb") as f:
                b64 = base64.b64encode(f.read()).decode("utf-8")

            if provider == "openai":
                raw_code = call_openai(b64, mime_type, args.api_key, args.api_base, model)
            else:
                raw_code = call_gemini(b64, mime_type, args.api_key, model)

            label = clean_label(raw_code)

            if not label or len(label) < 4 or len(label) > 7:
                print(f"⚠️ {progress} 识别结果疑似异常: '{raw_code}' -> '{label}' | 文件: {fname}，跳过")
                fail_cnt += 1
                continue

            _, ext = os.path.splitext(fname)
            new_fname = f"{label}_{int(time.time())}_{os.urandom(2).hex()}{ext}"
            dest_path = os.path.join(output_dir, new_fname)

            if args.dry_run:
                print(f"🔍 {progress} [预览] {fname} -> '{label}' -> {new_fname}")
            else:
                if args.copy:
                    with open(fpath, "rb") as rf, open(dest_path, "wb") as wf:
                        wf.write(rf.read())
                else:
                    os.rename(fpath, dest_path)
                print(f"✅ {progress} {fname} -> '{label}' -> {new_fname}")

            success_cnt += 1

        except Exception as e:
            print(f"❌ {progress} 处理 {fname} 失败: {e}")
            fail_cnt += 1

        if i < len(images) - 1 and args.delay > 0:
            time.sleep(args.delay)

    print(f"\n🎉 任务结束！成功: {success_cnt}，跳过/失败: {fail_cnt}")


if __name__ == "__main__":
    main()
