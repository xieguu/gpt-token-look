@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "Codex Token Lens Server" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
exit
