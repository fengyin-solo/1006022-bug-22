#!/usr/bin/env bash
# 摆渡车到站收尾的回归验证：tsc 编译后在 node 里跑（localStorage 自动退化为内存态）。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=/tmp/shuttle-verify-out
node_modules/.bin/tsc -p tsconfig.verify.json
find "$OUT" -name '*.js' -exec sed -i 's|require("@/|require("'"$OUT"'/src/|g' {} +
node "$OUT/verify/shuttle-verify.js"
