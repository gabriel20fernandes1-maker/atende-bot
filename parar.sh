#!/usr/bin/env bash
# ============================================================
# "Desligar Bia" no Linux/macOS - o par do desligar-bia.ps1.
#
# Derruba painel + supervisor + bot. NAO apaga nada: sessao, lista e estado
# ficam intactos. Desligar e dormir, nao e esquecer.
#
# Uso: ./parar.sh             (ou: npm run descer)
# ============================================================
set -e
cd "$(dirname "$0")"
exec node controle.js descer
