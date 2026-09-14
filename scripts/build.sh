#!/bin/bash
# dsh-travel build：编译 src/ → lib/。
# DSH_CHECKOUT 自动探测：环境变量 → 源码 checkout 常见路径 → 全局 npm 安装路径。
# 依赖 link 兼容两种 checkout 布局：源码树（vendor/、packages/）与全局包（node_modules/、
# node_modules/@deepseek-ai/）；checkout 缺某依赖时回退本地 node_modules（npm install 的 peer）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── DSH_CHECKOUT 探测 ──
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in \
    "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness" \
    "/usr/lib/node_modules/@deepseek-ai/dsh" "/usr/local/lib/node_modules/@deepseek-ai/dsh"; do
    if [ -d "$candidate" ] && { [ -d "$candidate/packages" ] || [ -d "$candidate/node_modules" ]; }; then
      CHECKOUT="$candidate"; break
    fi
  done
fi
if [ -z "$CHECKOUT" ] || { [ ! -d "$CHECKOUT/packages" ] && [ ! -d "$CHECKOUT/node_modules" ]; }; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT). Tried: \$DSH_CHECKOUT, \$HOME/dsh-harness, \$HOME/dsh, \$HOME/.dsh/dsh-harness, /usr/lib/node_modules/@deepseek-ai/dsh" >&2
  exit 1
fi
echo "build: dsh checkout @ $CHECKOUT"

# ── tsc 解析：checkout tsc → 本地 devDependency tsc ──
TSC=""
for cand in "$CHECKOUT/node_modules/.bin/tsc" "$CHECKOUT/node_modules/typescript/bin/tsc" "$ROOT/node_modules/.bin/tsc"; do
  if [ -e "$cand" ]; then TSC="$cand"; break; fi
done
if [ -z "$TSC" ]; then
  echo "build: no tsc found in checkout or local node_modules (run npm install first)" >&2
  exit 1
fi
echo "build: tsc @ $TSC"

# ── link 依赖（尽力而为：checkout 有目标则 link，否则回退本地）──
link_pkg() {
  local link="$ROOT/node_modules/$1"; shift
  local found=""
  for target in "$@"; do
    if [ -d "$target" ]; then found="$target"; break; fi
  done
  if [ -n "$found" ]; then
    node -e "
      const fs = require('fs');
      const path = require('path');
      const link = path.resolve(process.argv[1]);
      const target = path.resolve(process.argv[2]);
      fs.rmSync(link, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    " "$link" "$found"
    echo "  link $1 <- ${found#$CHECKOUT/}"
  elif [ -e "$link" ]; then
    echo "  skip $1 (checkout 无此依赖，用本地 node_modules 版本)"
  else
    echo "build: dependency '$1' missing in checkout and local node_modules" >&2
    exit 1
  fi
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg cordis \
  "$CHECKOUT/vendor/cordis" \
  "$CHECKOUT/node_modules/cordis" \
  "$CHECKOUT/node_modules/@deepseek-ai/cordis"
# 统一 '@deepseek-ai/cordis' 与 'cordis' 的模块身份：npm 落地的全局副本与 vendor
# 分裂（两者是不同 realpath → dsh-* 包的 Context 增强（declare module
# '@deepseek-ai/cordis'）并入不了 'cordis' 导入的程序）。重指同源后增强可靠合并。
link_pkg @deepseek-ai/cordis \
  "$CHECKOUT/vendor/cordis" \
  "$CHECKOUT/node_modules/@deepseek-ai/cordis"
link_pkg cosmokit \
  "$CHECKOUT/vendor/cosmokit" \
  "$CHECKOUT/node_modules/cosmokit" \
  "$CHECKOUT/node_modules/@deepseek-ai/cosmokit"
link_pkg schemastery \
  "$CHECKOUT/vendor/schemastery" \
  "$CHECKOUT/node_modules/schemastery" \
  "$CHECKOUT/node_modules/@deepseek-ai/schemastery"
link_pkg @deepseek-ai/dsh-tools \
  "$CHECKOUT/packages/core/tools" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-tools"
link_pkg @deepseek-ai/dsh-llm \
  "$CHECKOUT/packages/llm/llm" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-llm"
# ── settings/credentials 族（npm 回落的全局副本会把各自 Context 增强（declare
#    module '@deepseek-ai/cordis'）挂到「全局 cordis」模块上，与源码链的
#    'cordis'（vendor）身份分裂 → ctx.settings/ctx.credentials 不进程序。同源
#    link 后两族都从 harness 树解析 cordis，增强合并可靠。──
link_pkg @deepseek-ai/dsh-settings \
  "$CHECKOUT/packages/settings/settings" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-settings"
link_pkg @deepseek-ai/dsh-settings-file \
  "$CHECKOUT/packages/settings/settings-file" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-settings-file"
link_pkg @deepseek-ai/dsh-credentials \
  "$CHECKOUT/packages/credentials/credentials" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-credentials"
link_pkg @deepseek-ai/dsh-credentials-local \
  "$CHECKOUT/packages/credentials/credentials-local" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-credentials-local"
link_pkg @deepseek-ai/dsh-system-prompt \
  "$CHECKOUT/packages/core/system-prompt" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-system-prompt"
link_pkg @deepseek-ai/dsh-client-ui-slots \
  "$CHECKOUT/packages/client/ui-slots" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-client-ui-slots"
# ── W6 设置卡 client 半：运行时服务（host 提供）+ 构建/类型面（checkout link） ──
link_pkg @deepseek-ai/dsh-client-runtime \
  "$CHECKOUT/packages/client/runtime" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-client-runtime"
link_pkg @deepseek-ai/dsh-client-connection \
  "$CHECKOUT/packages/client/connection" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-client-connection"
link_pkg @deepseek-ai/dsh-client-locale \
  "$CHECKOUT/packages/client/locale" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-client-locale"
link_pkg @deepseek-ai/dsh-client-ui-settings \
  "$CHECKOUT/packages/client/ui-settings" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-client-ui-settings"
link_pkg @deepseek-ai/dsh-client-ui-settings-plugins \
  "$CHECKOUT/packages/client/ui-settings-plugins" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins"
# react/@types/react：源码 checkout 在 .pnpm 下（设置卡 JSX 类型面；运行时 host 提供）
REACT_DIR=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -name 'react@*' 2>/dev/null | head -1)
REACT_TYPES_DIR=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -name '@types+react@*' 2>/dev/null | head -1)
link_pkg react "$REACT_DIR/node_modules/react"
link_pkg @types/react "$REACT_TYPES_DIR/node_modules/@types/react"
link_pkg @deepseek-ai/dsh-web \
  "$CHECKOUT/packages/web/web" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-web"
link_pkg @deepseek-ai/dsh-host-webserver \
  "$CHECKOUT/packages/host/webserver" \
  "$CHECKOUT/node_modules/@deepseek-ai/dsh-host-webserver"
link_pkg @types/node \
  "$CHECKOUT/node_modules/@types/node"

# @standard-schema（dsh-tools 依赖；源码 checkout 在 .pnpm 下，全局包通常已装）
STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
if [ -n "$STD_SCHEMA" ]; then
  node -e "
    const fs = require('fs');
    const path = require('path');
    fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
    fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
    fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
  " "$STD_SCHEMA/node_modules/@standard-schema/spec"
else
  [ -e node_modules/@standard-schema ] && echo "  skip @standard-schema (用本地 node_modules 版本)"
fi

echo "=== Compiling src → lib ==="
"$TSC" -p tsconfig.json

# ── W6：client 半类型闸门（src/client 独立 tsconfig；tsdown 负责产物）──
echo "=== Typechecking client (tsconfig.client.json) ==="
"$TSC" -p tsconfig.client.json

# ── 非 TS 资产拷贝：render 模板（render.ts 运行时邻接 import.meta.url 读取）──
mkdir -p lib/render
if [ -f src/render/template.html ]; then
  cp src/render/template.html lib/render/template.html
  echo "  copy src/render/template.html → lib/render/template.html"
fi

# ── W4/T6 地图为核心页面 bundle：现有 esbuild 将独立 TS/CSS 页面内联资产编译为
#    lib/render/page.bundle.js；设置页仍由 tsdown 单独构建，二者入口不交叉。──
PAGE_ESBUILD="$ROOT/node_modules/.bin/esbuild"
mkdir -p lib/render/page
if [ -x "$PAGE_ESBUILD" ]; then
  "$PAGE_ESBUILD" src/render/page/runtime.ts \
    --bundle --platform=browser --format=iife --target=es2020 \
    --minify --log-level=error --outfile=lib/render/page.bundle.js
else
  npx --no-install esbuild src/render/page/runtime.ts \
    --bundle --platform=browser --format=iife --target=es2020 \
    --minify --log-level=error --outfile=lib/render/page.bundle.js
fi
cp src/render/page/styles.css lib/render/page/styles.css
echo "  bundle src/render/page/runtime.ts → lib/render/page.bundle.js"
echo "  copy src/render/page/styles.css → lib/render/page/styles.css"

# ── W4 T17 打包收口：Python 桥脚本随 lib 交付（npm files 仅含 lib；scripts/ 不入包）──
# 桥存在于 lib/scripts/trafilatura-extract.py（extract.ts 邻接 import.meta.url 定位），
# venv/.test-env/真实数据/evidence 永不进入 lib → 不入 npm 包。
if [ -f scripts/trafilatura-extract.py ]; then
  mkdir -p lib/scripts
  cp scripts/trafilatura-extract.py lib/scripts/trafilatura-extract.py
  chmod +x lib/scripts/trafilatura-extract.py
  echo "  copy scripts/trafilatura-extract.py → lib/scripts/trafilatura-extract.py"
fi

echo "=== Build complete ==="