@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Fazendo backup da Bia...
node backup.js
echo.
pause
