#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Trafilatura 可选正文桥（W1 DR2/T8；草稿 182）。

宿主进程内经 stdin 调入（非浏览器 evaluate、无 shell 拼接）：
    echo '<html>' | python3 trafilatura-extract.py  ->  {"text": "...", "date": "YYYY-MM-DD", ...}

边界（草稿 182）：
- stdin 输入（不拼接命令行参数/URL，防止注入与 shell 转义问题）
- 输出有界 JSON（脚本侧不再额外消费超长输入；宿主侧已有超时/输出上限）
- venv 不打包、不依赖工作区绝对路径；解释器缺失由宿主 try/spawn 侦测 → degraded

I/O 量纲（chore：char calibre，非 byte）：
- 本脚本全部限值以 Python str 字符（code point）计：sys.stdin.read(n)/len(str) 均为字符数，
  字符切片不按 UTF-8 字节截断（多字节字符不会被劈开）；字节级总量界由宿主
  （spawn 侧 stdout 累计字符上限 + stdin 拒绝超限输入）兜底。
- MAX_INPUT_CHARS=1M 字符：宿主在 spawn 前已按同值拒绝超限输入，脚本侧限值只作
  second line of defense（防极端路径）。
- MAX_OUTPUT_CHARS=5M 字符：text 截断与 stdout.write 均为字符索引
  （payload[:MAX_OUTPUT_CHARS*2] 的 ×2 为多字节 UTF-8 编码宽松量，仅影响字节宽度，
  不影响字符语义）。

日期诚实（草稿 183）：
- date 只取来源明确字段（article:published_time / time[datetime]）
- 不把抓取时间、季节词当发布日期（宿主侧仍做启发式 dateEvidence 分离）

本脚本随 lib 打包（T17 复核 lib 布局）；trafilatura 库可选，缺省走内置降级提取。
"""
import json
import re
import sys

# F1#6 有界 I/O：stdin 读取上限（字符，防宿主传入超大 HTML 撑爆内存）与
# stdout 输出上限（字符，防提取文本无限膨胀；超出截断并显式标记）。
MAX_INPUT_CHARS = 1_000_000
MAX_OUTPUT_CHARS = 5_000_000

try:
    import trafilatura  # type: ignore
    HAVE_TRAF = True
except Exception:  # pragma: no cover - 可选依赖
    HAVE_TRAF = False


def _strip(html: str) -> str:
    """内置降级 HTML→文本（trafilatura 缺席时兜底；不执行任何标签）。"""
    text = re.sub(r"<(script|style|noscript)[\s\S]*?</\1>", " ", html, flags=re.I)
    text = re.sub(r"<!--[\s\S]*?-->", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _explicit_date(html: str):
    m = re.search(r'<time[^>]+datetime="(\d{4}-\d{2}-\d{2})"', html, re.I)
    if m:
        return m.group(1)
    m = re.search(
        r'<meta[^>]+(?:property|itemprop)="(?:article:published_time|datePublished)"[^>]+content="(\d{4}-\d{2}-\d{2})',
        html, re.I,
    )
    if m:
        return m.group(1)
    return None


def _read_stdin_capped() -> tuple[str, bool]:
    """有界 stdin 读取（F1#6）：最多 MAX_INPUT_CHARS 字符；超限截断并标记 inputTruncated。

    逐块累计而不是一次性 read()，避免超大输入一次性驻留内存。
    量纲：sys.stdin.read(n) 与 len(chunk) 均为字符（char）计数，非字节。
    边界精度：超限判断在 append 之后，返回串最多可超出上限一个分块
    （≤64K 字符）——宿主侧已在 spawn 前以同值拒绝超限输入，此处按有界近似处理，
    不做逐字符精裁（避免 O(n) 二次拷贝）。
    """
    chunks: list[str] = []
    total = 0
    truncated = False
    while True:
        try:
            chunk = sys.stdin.read(min(64 * 1024, MAX_INPUT_CHARS - total))
        except Exception:  # pragma: no cover
            break
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total >= MAX_INPUT_CHARS:
            truncated = True
            # 丢弃剩余输入（不再读），防无限输入放大（返回串可能恰好超出 ≤1 个分块，
            # 见函数 docstring 的边界精度说明）
            break
    return "".join(chunks), truncated


def main() -> int:
    html, input_truncated = _read_stdin_capped()
    out: dict = {"text": "", "mediaUnresolved": False}
    if input_truncated:
        out["inputTruncated"] = True
    if HAVE_TRAF:
        try:
            text = trafilatura.extract(html, include_comments=False, include_tables=False) or ""
            out["text"] = text.strip()
        except Exception:  # pragma: no cover
            out["text"] = _strip(html)
    else:
        out["text"] = _strip(html)
    if len(out["text"]) > MAX_OUTPUT_CHARS:
        out["text"] = out["text"][:MAX_OUTPUT_CHARS]
        out["truncated"] = True
        out["truncatedReason"] = "Trafilatura 桥输出超过 %d 字符上限，已截断" % MAX_OUTPUT_CHARS
    if re.search(r"<img|<video|<figure", html, re.I):
        out["mediaUnresolved"] = True
    date = _explicit_date(html)
    if date:
        out["date"] = date
    payload = json.dumps(out, ensure_ascii=False)
    # stdout 字符序容量：payload[:MAX_OUTPUT_CHARS*2] 为字符索引（×2 是 UTF-8 多字节宽松量）。
    # 宿主编解码后另有自己的字符上限（maxOutputChars）兜底；本行只防极端 JSON 膨胀。
    sys.stdout.write(payload[:MAX_OUTPUT_CHARS * 2])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # pragma: no cover
        sys.stderr.write("trafilatura bridge error: %s\n" % (exc,))
        sys.exit(1)
