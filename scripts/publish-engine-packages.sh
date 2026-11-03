#!/usr/bin/env bash
# 发布 engine-packages/ 里的每个平台引擎包（先跑 build-engine-packages.mjs 生成）。
# 每个包各 npm publish 一次（网页验证会弹几次）。已是最新版的会跳过。
# 引擎版本很少换，所以这一步通常只在换引擎时做一次。
set -euo pipefail
cd "$(dirname "$0")/.."
dir=engine-packages
[ -d "$dir" ] || { echo "没有 ${dir}，先运行：node scripts/build-engine-packages.mjs"; exit 1; }

for pkg in "$dir"/*/; do
  name=$(node -p "require('./$pkg/package.json').name")
  ver=$(node -p "require('./$pkg/package.json').version")
  have=$(npm view "${name}@${ver}" version 2>/dev/null || true)
  if [ "$have" = "$ver" ]; then
    echo "跳过 ${name}@${ver}（已发布）"
    continue
  fi
  echo "发布 ${name}@${ver} …"
  ( cd "$pkg" && npm publish --access public )
done
echo "完成。"
