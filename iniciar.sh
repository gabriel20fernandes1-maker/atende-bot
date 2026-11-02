#!/usr/bin/env bash
# ============================================================
# "Ligar Bia" no Linux/macOS - o par do ligar-bia.ps1.
#
# Sobe o painel e abre o navegador. A Bia (o bot) NAO sobe junto: quem sobe e
# o botao "Subir a Bia" dentro do painel, igual no Windows.
#
# Uso: ./iniciar.sh          (ou: npm run subir)
# ============================================================
set -e
cd "$(dirname "$0")"
exec node controle.js subir "$@"
