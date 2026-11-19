@echo off
cd /d "%~dp0"
if not exist "dist-electron\main\main.js" (
  call pnpm build
)
start "" "node_modules\electron\dist\electron.exe" .
