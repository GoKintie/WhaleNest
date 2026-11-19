#!/bin/sh
# 诊断 adb 到 MuMu 的连接状态（容器内运行）
EP="${1:?请提供 ADB 主机和端口}"
echo "=== target: $EP ==="
adb kill-server >/dev/null 2>&1
sleep 1
adb start-server >/dev/null 2>&1
sleep 1
adb disconnect "$EP" >/dev/null 2>&1
echo "--- connect ---"
timeout 25 adb connect "$EP" 2>&1
i=0
while [ $i -lt 6 ]; do
  i=$((i+1))
  sleep 1
  S=$(adb devices | awk 'NR==2 {print $2}')
  echo "t=${i}s state=${S:-none}"
done
echo "--- devices -l ---"
adb devices -l 2>&1
echo "--- probe wm size ---"
timeout 15 adb -s "$EP" shell wm size 2>&1 | head -3
