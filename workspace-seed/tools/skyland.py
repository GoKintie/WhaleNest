#!/usr/bin/env python3
# 森空岛签到 Python 包装入口（兼容直接调用 python /workspace/tools/skyland.py）
import subprocess, sys, os

here = os.path.dirname(os.path.abspath(__file__))
mjs = os.path.join(here, "skyland.mjs")
res = subprocess.run(["node", mjs] + sys.argv[1:])
sys.exit(res.returncode)
