import { Chess } from '../../vendor/chess.js';
import { api } from '../api.js';
import { Board } from '../board.js';
import { state } from '../state.js';
import { h, toast, playSound } from '../util.js';

const LEVELS = { 1: 'Débutant', 2: 'Intermédiaire', 3: 'Avancé' };

export async function render(root) {
  const host = h('div');
  root.append(host);
  let cleanup = null;

  async function list() {
    if (cleanup) { cleanup(); cleanup = null; }
    host.innerHTML = '';
    const drills = await api.endgames();
    host.append(h('div.page-head', h('div', h('h1', 'Finales'),
      h('div.muted', 'Les finales de base qui font gagner des points entre 1300 et 1800. Joue-les contre Stockfish à pleine force.'))));
    const grid = h('div.grid.g2');
    drills.forEach(d => grid.append(h('div.drill', { onclick: () => play(d) },
      h('div', { style: { fontSize: '30px' } }, d.goal === 'win' ? '🏆' : '🛡'),
      h('div', { style: { flex: 1 } }, h('b', d.title), h('div.small.muted', d.goal === 'win' ? 'Objectif : gagner (mat)' : 'Objectif : tenir la nulle'),
        h('div.row.small', h('span.lvl', LEVELS[d.level]), h('span.dim', d.attempts ? `${d.successes}/${d.attempts} réussis` : 'jamais tenté'))),
      h('div', { style: { width: '70px' } }, h('div.bar', h('i', { style: { width: (d.attempts ? 100 * d.successes / d.attempts : 0) + '%' } }))))));
    host.append(grid);
  }

  async function play(d) {
    host.innerHTML = '';
    const start = new Chess(d.fen);
    const user = start.turn();
    const chess = new Chess(d.fen);
    let busy = false, over = false, hist = [];
    const boardHost = h('div');
    const status = h('div');
    const fb = h('div');
    host.append(h('div.page-head', h('button.btn.sm', { onclick: list }, '← Finales'), h('div', h('h1', d.title), h('div.muted', d.goal === 'win' ? 'Objectif : mater l\'adversaire.' : 'Objectif : ne pas perdre — tiens la nulle (ou survis 40 coups).'))),
      h('div.review', h('div.boardcol', boardHost),
        h('div', h('div.card', h('h2', '💡 Idée clé'), h('div', d.tip), status, fb,
          h('div.row', { style: { marginTop: '12px' } },
            h('button.btn', { onclick: () => play(d) }, '↻ Recommencer'),
            h('button.btn', { onclick: hint }, '💡 Indice (meilleur coup)'),
            h('button.btn', { onclick: undo }, '↶ Annuler')),
          h('div.small.dim', { style: { marginTop: '10px' } }, `Tu joues les ${user === 'w' ? 'Blancs' : 'Noirs'}. Stockfish joue à pleine force.`)))));
    const board = new Board(boardHost, { orientation: user, interactive: true, movable: user, theme: state.settings.board_theme, onMove: m => onMove(m) });
    board.setFen(d.fen);
    cleanup = () => { over = true; };

    function check() {
      if (over) return true;
      const full = chess.moveNumber ? chess.moveNumber() : 1;
      const startFull = +d.fen.split(' ')[5] || 1;
      const played = full - startFull;
      let res = null;
      if (chess.isCheckmate()) res = chess.turn() === user ? 'loss' : 'win';
      else if (chess.isDraw()) res = 'draw';
      else if (d.goal === 'draw' && played >= 40) res = 'held';
      else if (d.goal === 'win' && played >= 50) res = 'slow';
      if (!res) return false;
      over = true;
      const ok = d.goal === 'win' ? res === 'win' : (res === 'draw' || res === 'held');
      const msg = { win: 'Mat ! Bien joué 🏆', loss: 'Tu as été maté.', draw: d.goal === 'win' ? 'Nulle : tu n\'as pas su gagner (règle des 50 coups, pat, répétition…).' : 'Nulle obtenue ! 🛡', held: 'Tu as tenu 40 coups : position défendue 🛡', slow: 'Trop lent : au-delà de 50 coups sans mat.' }[res];
      fb.innerHTML = '';
      fb.append(h('div.feedback.' + (ok ? 'ok' : 'ko'), msg));
      playSound(ok ? 'ok' : 'error', state.settings.sound);
      api.endgameResult(d.id, ok);
      return true;
    }
    async function onMove(m) {
      if (busy || over) { board.setFen(chess.fen()); return; }
      chess.move({ from: m.from, to: m.to, promotion: m.promotion });
      hist.push(chess.fen());
      board.play(m.uci);
      board.setArrows([]);
      playSound(m.captured ? 'capture' : 'move', state.settings.sound);
      if (check()) return;
      busy = true; status.innerHTML = ''; status.append(h('div.small.muted', { style: { marginTop: '8px' } }, 'Stockfish joue…'));
      try {
        const r = await api.play(chess.fen(), 3190, 500);
        chess.move({ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), promotion: r.uci[4] });
        board.play(r.uci);
        playSound('move', state.settings.sound);
      } catch (e) { toast(e.message, 'err'); }
      busy = false; status.innerHTML = '';
      check();
    }
    async function hint() {
      if (over || busy || chess.turn() !== user) return;
      const r = await api.bestMove(chess.fen());
      board.setArrows([{ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4), color: '#5c8bb0' }]);
    }
    function undo() {
      if (busy || over || chess.history().length < 2) return;
      chess.undo(); chess.undo(); board.setFen(chess.fen()); board.setArrows([]);
    }
  }

  await list();
  return () => cleanup && cleanup();
}
