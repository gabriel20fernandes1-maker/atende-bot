@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if "%~1"=="" (
  echo Arraste o arquivo de backup ^(bia-backup-....zip^) sobre este .bat,
  echo ou informe o caminho:  RESTAURAR.bat "C:\caminho\bia-backup-....zip"
  echo.
  pause
  exit /b 1
)
echo Restaurando a Bia a partir de: %~1
node restaurar.js "%~1"
echo.
pause
