@echo off
chcp 65001 >nul
title Bia - empresa
cd /d "%~dp0"
echo.
echo   Iniciando a Bia (empresa)...
echo   O painel vai abrir no navegador em alguns segundos.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" -AbrirPainel
if errorlevel 1 (
  echo.
  echo   Algo deu errado. Tire um print desta janela e envie para o suporte.
  echo.
  pause
)
