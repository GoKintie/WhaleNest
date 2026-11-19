#!/bin/sh
# 肥鱼语音合成入口脚本 (/workspace/tools/tts.sh · v2.8)
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/tts.mjs" "$@"
