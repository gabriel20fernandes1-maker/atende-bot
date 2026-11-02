@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo Instalando a Bia (empresa)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1"
echo.
pause
