'use strict';

// ============================================================
// Horario de funcionamento da empresa, e a janela do bot.
//
// Sao o mesmo horario: a Bia so envia/responde quando a unidade esta aberta.
// Fonte da verdade: config.atendimento.dias (indice 0=domingo ... 6=sabado).
//
// O relogio e calculado com Intl.DateTimeFormat no fuso de config.fuso, e nao
// com a hora da maquina. Este e o UNICO lugar do codigo que le o relogio: se
// `getHours`/`getDay`/`Intl` aparecer em outro arquivo, o check falha.
// ============================================================

const config = require('./config');

const NOMES_DIA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function nomeDia(dia) {
  return NOMES_DIA[dia] || 'dia';
}

// "09:00" -> "9h", "14:00" -> "14h"
function horaCurta(hhmm) {
  const [h, m] = String(hhmm).split(':');
  const min = Number(m) || 0;
  return min ? `${Number(h)}h${String(min).padStart(2, '0')}` : `${Number(h)}h`;
}

function emMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':');
  return Number(h) * 60 + (Number(m) || 0);
}

const DIAS_INTL = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Relogio de teste (BIA_AGORA / BIA_DIA) ou o agora de verdade.
//
// O dia e a hora vem do fuso configurado, via Intl.DateTimeFormat - que
// resolve horario de verao sozinho. Antes isto usava `d.getHours()`/`getDay()`,
// ou seja, a hora da MAQUINA: rodando num PC em outro fuso, a janela fechava
// na hora errada e a Bia ficava muda sem ninguem entender.
function agora(base = new Date()) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: config.fuso,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(base);

  const p = {};
  for (const parte of partes) p[parte.type] = parte.value;

  // Falha fechado: se por algum motivo o Intl nao devolver o dia, assume
  // domingo (fechado) em vez de responder em horario incerto.
  let dia = DIAS_INTL[p.weekday];
  if (dia == null) dia = 0;
  let minutos = Number(p.hour) * 60 + Number(p.minute);

  // Relogio de teste sobrepoe o real.
  const temDia = Number.isInteger(config.diaDeTeste) && config.diaDeTeste >= 0 && config.diaDeTeste <= 6;
  const temHora = typeof config.horaDeTeste === 'string' && /^\d{1,2}:\d{2}$/.test(config.horaDeTeste);
  if (temDia) dia = config.diaDeTeste;
  if (temHora) minutos = emMinutos(config.horaDeTeste);
  else if (temDia) minutos = 12 * 60; // meio-dia, um horario neutro

  return { dia, minutos, hora: Math.floor(minutos / 60), minuto: minutos % 60 };
}

// Data de hoje no fuso configurado, "YYYY-MM-DD". Usada pelo log de decisao
// para agrupar por dia sem depender do relogio da maquina.
function hojeISO(base = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(base);
}

function faixaDoDia(dia) {
  const dias = config.atendimento.dias;
  if (!Object.prototype.hasOwnProperty.call(dias, dia)) return null;
  return dias[dia] || null;
}

// -> { aberto: boolean, motivo: string }
function emAtendimento(a = agora()) {
  const faixa = faixaDoDia(a.dia);
  if (!faixa) {
    return { aberto: false, motivo: `fechado (${nomeDia(a.dia)})` };
  }
  const abre = emMinutos(faixa.abre);
  const fecha = emMinutos(faixa.fecha);
  if (a.minutos < abre) {
    return { aberto: false, motivo: `abre às ${horaCurta(faixa.abre)}` };
  }
  if (a.minutos >= fecha) {
    return { aberto: false, motivo: `fecha às ${horaCurta(faixa.fecha)}` };
  }
  return { aberto: true, motivo: `aberto ${horaCurta(faixa.abre)}-${horaCurta(faixa.fecha)}` };
}

// Condicao real de envio: checagem de horario, com a forcagem para teste.
// Sempre devolve { ok, motivo } - bot.js e send.js leem .ok, entao o formato
// nao pode vazar o { aberto } de emAtendimento.
function podeEnviar(a = agora()) {
  if (config.forcarForaDaJanela) return { ok: true, motivo: 'forcado' };
  const r = emAtendimento(a);
  return { ok: r.aberto, motivo: r.motivo };
}

// "segunda a sexta das 9h às 18h e sábado das 9h às 14h" - montado a partir do
// config, para o texto nunca divergir da tabela.
function resumoSemana() {
  const dias = config.atendimento.dias;
  const grupos = [];
  for (let d = 1; d <= 6; d++) {
    const faixa = dias[d];
    if (!faixa) continue;
    const txt = `${horaCurta(faixa.abre)} às ${horaCurta(faixa.fecha)}`;
    const ult = grupos[grupos.length - 1];
    if (ult && ult.txt === txt && ult.ate === d - 1) {
      ult.ate = d;
    } else {
      grupos.push({ txt, de: d, ate: d });
    }
  }
  if (!grupos.length) return '';

  const partes = grupos.map((g) => {
    const quem = g.de === g.ate ? nomeDia(g.de) : `${nomeDia(g.de)} a ${nomeDia(g.ate)}`;
    return `${quem} das ${g.txt}`;
  });

  if (partes.length === 1) return partes[0];
  return `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

// A frase sobre turmas saiu de cena: o repique nao fala de turma. Quem da
// horario de turma e a equipe, no contato direto.

module.exports = {
  NOMES_DIA,
  agora,
  hojeISO,
  nomeDia,
  horaCurta,
  emMinutos,
  faixaDoDia,
  emAtendimento,
  podeEnviar,
  resumoSemana,
};
