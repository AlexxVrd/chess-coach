import { Chess } from '../../vendor/chess.js';
import { api } from '../api.js';
import { Board } from '../board.js';
import { state } from '../state.js';
import { h, store, toast, playSound } from '../util.js';

const KINDS = [
  ['critical', '🧩', 'Mes erreurs', 'Rejoue la position de l\'une de tes erreurs et fais mieux.'],
  ['convert', '🏆', 'Convertir un avantage', 'Tu étais mieux : prouve que tu sais gagner la partie.'],
  ['opening', '🌳', 'Mon répertoire', 'Pars d\'une position de ton répertoire et joue la suite.'],
  ['free', '♟', 'Partie libre', 'Partie complète depuis la position initiale.'],
];

export async function render(root) {
  const host = h('div');
  root.append(host);
  let cleanup = null;
  const levels = [[1400, 'Facile'], [1700, 'Moyen'], [2000, 'Fort'], [2300, 'Très fort'], [3190, 'Maximum']];

  function menu() {
    if (cleanup) { cleanup(); cleanup = null; }
    host.innerHTML = '';
    let elo = store.get('sp.elo', 1700);
    const chips = h('div.chips');
    const draw = () => { chips.innerHTML = ''; levels.forEach(([e, l]) => chips.append(h('div.chip' + (elo === e ? '.on' : ''), { onclick: () => { elo = e; store.set('sp.elo', e); draw(); } }, `${l} (${e === 3190 ? 'max' : e})`))); };
    draw();
    host.append(h('div.page-head', h('div', h('h1', 'Sparring'),
      h('div.muted', 'Jouer, c\'est ce qui fait progresser. Ici tu rejoues les moments qui comptent pour toi, contre Stockfish à la force de ton choix.'))),
      h('div.card', h('h3', 'Force de l\'adversaire'), chips,
        h('div.small.dim', { style: { marginTop: '6px' } }, 'Conseil : choisis un niveau où tu gagnes environ une partie sur deux.')));
    const grid = h('div.grid.g2', { style: { marginTop: '14px' } });
    KINDS.forEach(([k, ic, t, d]) => grid.append(h('div.drill', { onclick: () => start(k, elo) },
      h('div', { style: { fontSize: '30px' } }, ic), h('div', h('b', t), h('div.small.muted', d)))));
    host.append(grid);
  }

  async function start(kind, elo, exclude) {
    let pos;
    try { pos = await api.sparringPosition(kind, exclude); } catch (e) { toast(e.message, 'err'); return; }
    play(pos, elo);
  }

  async function play(pos, elo) {
    host.innerHTML = '';
    const user = pos.color;
    const chess = new Chess(pos.fen);
    let busy = false, over = false, startCp = null;
    const boardHost = h('div'), status = h('div'), fb = h('div'), goal = h('div.small.muted'), hist = h('div');
    host.append(h('div.page-head', h('button.btn.sm', { onclick: menu }, '← Sparring'), h('div', h('h1', pos.title), h('div.muted', pos.tip))),
      h('div.review', h('div.boardcol', boardHost),
        h('div', h('div.card', goal, status, fb, hist,
          h('div.row', { style: { marginTop: '12px', flexWrap: 'wrap' } },
            h('button.btn', { onclick: () => start(pos.kind, elo, pos.fen) }, '⏭ Autre position'),
            h('button.btn', { onclick: () => play(pos, elo) }, '↻ Recommencer'),
            h('button.btn', { onclick: hint }, '💡 Meilleur coup'),
            h('button.btn', { onclick: undo }, '↶ Annuler'),
            h('button.btn', { onclick: () => finish('resign') }, '🏳 Abandonner'),
            h('a.btn', { href: '#/analysis?fen=' + encodeURIComponent(pos.fen) }, '🔬 Analyser le départ')),
          h('div.small.dim', { style: { marginTop: '10px' } }, `Tu joues les ${user === 'w' ? 'Blancs' : 'Noirs'} · Stockfish ≈ ${elo === 3190 ? 'maximum' : elo}.` + (pos.opening ? ` Position après : ${pos.opening}` : ''))))));
    const board = new Board(boardHost, { orientation: user, interactive: true, movable: user, theme: state.settings.board_theme, onMove: m => onMove(m) });
    board.setFen(pos.fen);
    cleanup = () => { over = true; };

    api.bestMove(pos.fen).then(r => {
      const mine = user === 'w' ? r.cp : -r.cp;
      startCp = r.mate != null ? ((user === 'w') === (r.mate > 0) ? 900 : -900) : mine;
      goal.textContent = startCp >= 150 ? 'Objectif : GAGNER la partie (tu es mieux).' : startCp <= -150 ? 'Objectif : TENIR (position difficile) — vise la nulle ou mieux.' : 'Position équilibrée : fais mieux que ton adversaire.';
    }).catch(() => {});

    function renderHist() {
      hist.innerHTML = '';
      const hh = chess.history();
      const first = pos.fen.split(' ');
      let n = +first[5] || 1, w = first[1] === 'w';
      const out = [];
      hh.forEach((san, i) => { if (w || i === 0) out.push(w ? `${n}. ${san}` : `${n}… ${san}`); else out.push(san); if (!w) n++; w = !w; });
      hist.append(h('div.small.dim', { style: { marginTop: '8px' } }, out.join(' ')));
    }
    function result() {
      if (chess.isCheckmate()) return chess.turn() === user ? 'loss' : 'win';
      if (chess.isDraw() || chess.isStalemate()) return 'draw';
      return null;
    }
    function finish(res) {
      if (over) return;
      over = true;
      const msg = { win: 'Mat ! Tu as gagné 🏆', loss: 'Tu as été maté.', draw: 'Partie nulle.', resign: 'Tu as abandonné.' }[res];
      const good = res === 'win' || (res === 'draw' && startCp !== null && startCp <= 150);
      fb.innerHTML = '';
      fb.append(h('div.feedback.' + (good ? 'ok' : 'ko'), msg,
        res === 'draw' && startCp >= 150 ? h('div.small', { style: { fontWeight: 400 } }, 'Tu étais mieux : revois comment conclure.') : null,
        h('div.row', { style: { marginTop: '8px' } }, h('a.btn.sm', { href: '#/analysis?fen=' + encodeURIComponent(chess.fen()) }, '🔬 Analyser la position finale'),
          h('button.btn.sm.primary', { onclick: () => start(pos.kind, elo, pos.fen) }, 'Position suivante'))));
      playSound(good ? 'ok' : 'error', state.settings.sound);
      api.dailyLog('sparring').catch(() => {});
    }
    async function reply() {
      busy = true; status.replaceChildren(h('div.small.muted', { style: { marginTop: '8px' } }, 'Stockfish réfléchit…'));
      try {
        const r = await api.play(chess.fen(), elo, elo >= 3190 ? 900 : 600);
        if (over) return;
        chess.move({ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), promotion: r.uci[4] });
        board.play(r.uci); playSound('move', state.settings.sound);
      } catch (e) { toast(e.message, 'err'); }
      busy = false; status.innerHTML = ''; renderHist();
      const res = result(); if (res) finish(res);
    }
    async function onMove(m) {
      if (busy || over || chess.turn() !== user) { board.setFen(chess.fen()); return; }
      chess.move({ from: m.from, to: m.to, promotion: m.promotion });
      board.play(m.uci); board.setArrows([]);
      playSound(m.captured ? 'capture' : 'move', state.settings.sound);
      renderHist();
      const res = result(); if (res) { finish(res); return; }
      await reply();
    }
    async function hint() {
      if (over || busy || chess.turn() !== user) return;
      const r = await api.bestMove(chess.fen());
      board.setArrows([{ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), color: '#5c8bb0' }]);
    }
    function undo() {
      if (busy || over || chess.history().length < 2) return;
      chess.undo(); chess.undo(); board.setFen(chess.fen()); board.setArrows([]); renderHist();
    }
    if (chess.turn() !== user) await reply();
  }

  menu();
  return () => cleanup && cleanup();
}
