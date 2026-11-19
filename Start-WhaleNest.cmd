@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.19 or newer, then start WhaleNest again.
  pause
  exit /b 1
)
node -e "const [m,n]=process.versions.node.split('.').map(Number);process.exit(m>22||(m===22&&n>=19)?0:1)"
if errorlevel 1 (
  echo WhaleNest needs Node.js 22.19 or newer.
  pause
  exit /b 1
)
if not exist "node_modules\undici\package.json" (
  call npm.cmd ci --omit=dev
  if errorlevel 1 goto failed
)
node build/start-local.mjs
if errorlevel 1 goto failed
exit /b 0

:failed
echo WhaleNest could not start. Review the error above.
pause
exit /b 1
