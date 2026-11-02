'use strict';

// ============================================================
// Nome de gente, limpo.
//
// A lista importada vem do painel da empresa e o WhatsApp vive cheio de
// "Maria 🌸", "🌸🌸" e emoji colado na letra. Emoji nao e nome: o que vale
// e a letra. Um nome sem NENHUMA letra nao e nome - quem chama decide o que
// fazer (o repique cai na fala sem nome; o aviso da equipe mostra so o
// numero).
//
// Puro de proposito: sem config, sem I/O. Quem precisa (templates, numeros,
// importar) importa daqui.
// ============================================================

// Letra (qualquer alfabeto) + acento combinante. Apostrofo e hifen so valem
// ENTRE letras: e o que segura "D'Avila" e "Ana-Maria" sem deixar passar
// "-" ou "'''" soltos.
const TOKEN = /[\p{L}\p{M}]+(?:['-][\p{L}\p{M}]+)*/u;

// Tudo o que nao e letra, acento, espaco, apostrofo ou hifen vira espaco.
// Emoji, simbolo, digito e pontuacao caem aqui.
const NAO_E_NOME = /[^\p{L}\p{M}\s'-]+/gu;

function tokenLimpo(token) {
  const achado = String(token == null ? '' : token).match(TOKEN);
  return achado ? achado[0] : '';
}

// "Maria 🌸 Aparecida" -> "Maria Aparecida"
// "Maria🌸Silva"        -> "Maria Silva"
// "🌸🌸"                 -> null
// "D'Avila"             -> "D'Avila"
// "Ana-Maria"           -> "Ana-Maria"
// "Léo😀"               -> "Léo"
// "123"                 -> null
function limparNome(nome) {
  const tokens = String(nome == null ? '' : nome)
    .replace(NAO_E_NOME, ' ')
    .split(/\s+/)
    .map(tokenLimpo)
    .filter(Boolean);
  return tokens.length ? tokens.join(' ') : null;
}

// "Maria Aparecida Silva" -> "Maria". Devolve null quando nao sobra letra.
function primeiroNome(nome) {
  const limpo = limparNome(nome);
  return limpo ? limpo.split(' ')[0] : null;
}

module.exports = { limparNome, primeiroNome };
