#!/bin/sh
# 实时联网搜索入口脚本 (/workspace/tools/websearch.sh · v2.9)
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/websearch.mjs" "$@"
