import { Chess } from '../../vendor/chess.js';
import { api, LiveEngine } from '../api.js';
import { Board, START_FEN } from '../board.js';
import { state } from '../state.js';
import { h, fmtEval, winPct, store, toast, playSound } from '../util.js';

/** Free analysis board: engine lines, PGN/FEN loading, and play-against-Stockfish at a chosen Elo. */
export async function render(root, params) {
  let moves = [], idx = 0, startFen = params.fen ? decodeURIComponent(params.fen) : START_FEN;
  let vsEngine = null;   // {color: user color, elo}
  let live, engineOn = store.get('an.engine', true), lines = [], busy = false;

  const boardHost = h('div');
  const evalFill = h('div.fill'), evalTop = h('div.txt.top'), evalBot = h('div.txt.bot');
  const evalbar = h('div.evalbar', evalFill, evalTop, evalBot);
  const linesBox = h('div');
  const moveBox = h('div.movelist');
  const fenIn = h('input', { type: 'text', style: { width: '100%' }, placeholder: 'FEN' });
  const pgnIn = h('textarea', { rows: 4, placeholder: 'Colle un PGN ici pour le charger…' });
  const status = h('div');
  const eloIn = h('input', { type: 'range', min: 1320, max: 3190, step: 10, value: store.get('an.elo', 1600) });
  const eloLbl = h('b', eloIn.value);
  eloIn.oninput = () => { eloLbl.textContent = eloIn.value; store.set('an.elo', +eloIn.value); };

  const board = new Board(boardHost, { interactive: true, movable: 'both', theme: state.settings.board_theme, onMove: m => onMove(m) });
  const chess = () => new Chess(startFen);

  root.append(
    h('div.page-head', h('div', h('h1', 'Analyse libre'), h('div.muted', 'Échiquier libre avec Stockfish — ou joue une partie contre lui à ton niveau.'))),
    h('div.review',
      h('div.boardcol', h('div.boardwrap', evalbar, h('div', { style: { flex: 1 } }, boardHost)),
        h('div.navbtns',
          h('button.btn.icon', { onclick: () => goto(0) }, '⏮'), h('button.btn.icon', { onclick: () => goto(idx - 1) }, '◀'),
          h('button.btn.icon', { onclick: () => goto(idx + 1) }, '▶'), h('button.btn.icon', { onclick: () => goto(moves.length) }, '⏭'),
          h('button.btn.icon', { title: 'Retourner', onclick: () => { board.flip(); evalbar.classList.toggle('flip'); } }, '⟲')), status),
      h('div',
        h('div.card',
          h('div.row', h('h2', { style: { margin: 0 } }, 'Moteur'), h('label.switch.right', h('input', { type: 'checkbox', checked: engineOn, onchange: e => { engineOn = e.target.checked; store.set('an.engine', engineOn); live.setEnabled(engineOn); if (!engineOn) { linesBox.innerHTML = ''; } else ask(); } }), 'Activé')),
          linesBox),
        h('div.card', h('h2', 'Jouer contre Stockfish'),
          h('div.row', 'Niveau Elo : ', eloLbl, eloIn),
          h('div.row', { style: { marginTop: '10px' } },
            h('button.btn.primary', { onclick: () => startGame('w') }, 'Jouer les Blancs'), h('button.btn.primary', { onclick: () => startGame('b') }, 'Jouer les Noirs'),
            h('button.btn', { onclick: () => { vsEngine = null; setStatus(''); toast('Mode analyse'); } }, 'Arrêter')),
          h('div.small.dim', { style: { marginTop: '6px' } }, 'Astuce : charge une position d\'une de tes parties (ou une finale) et joue-la contre le moteur pour t\'entraîner à convertir ou à défendre.')),
        h('div.card', h('h2', 'Coups'), moveBox,
          h('div.row', { style: { marginTop: '8px' } }, h('button.btn.sm', { onclick: undo }, '↶ Annuler'), h('button.btn.sm', { onclick: () => { moves = []; idx = 0; startFen = START_FEN; render0(); } }, 'Nouvelle partie'))),
        h('div.card', h('h2', 'Charger'), h('div.row', fenIn, h('button.btn.sm', { onclick: loadFen }, 'FEN')), h('div', { style: { height: '8px' } }), pgnIn, h('button.btn.sm', { style: { marginTop: '6px' }, onclick: loadPgn }, 'Charger le PGN')))));

  live = new LiveEngine(onLive);
  live.setEnabled(engineOn);

  function setStatus(t) { status.innerHTML = ''; if (t) status.append(h('div.feedback.info', t)); }
  function fenAt(i) { const c = chess(); for (let k = 0; k < i; k++) c.move({ from: moves[k].uci.slice(0, 2), to: moves[k].uci.slice(2, 4), promotion: moves[k].uci[4] }); return c; }

  function render0(hint) {
    const c = fenAt(idx);
    board.setFen(c.fen(), hint);
    if (idx > 0) { const m = moves[idx - 1]; board.setLast(m.uci.slice(0, 2), m.uci.slice(2, 4)); } else board.setLast(null);
    fenIn.value = c.fen();
    moveBox.innerHTML = '';
    const first = startFen.split(' ')[1] === 'b' ? 1 : 0;
    if (first) moveBox.append(h('div.no', '1.'), h('div', '…'));
    moves.forEach((m, i) => {
      const n = i + first;
      if (n % 2 === 0) moveBox.append(h('div.no', Math.floor(n / 2) + 1 + '.'));
      moveBox.append(h('div.mv' + (i + 1 === idx ? '.cur' : ''), { onclick: () => goto(i + 1) }, m.san));
    });
    ask();
    if (c.isGameOver()) setStatus(c.isCheckmate() ? 'Échec et mat.' : 'Partie nulle.');
  }
  function goto(i) { const p = idx; idx = Math.max(0, Math.min(moves.length, i)); render0(idx === p + 1 ? { from: moves[idx - 1].uci.slice(0, 2), to: moves[idx - 1].uci.slice(2, 4) } : undefined); }
  function undo() { if (!moves.length) return; moves.length = vsEngine && moves.length > 1 ? Math.max(0, moves.length - 2) : moves.length - 1; idx = moves.length; render0(); }

  async function onMove(m) {
    if (vsEngine && fenAt(idx).turn() !== vsEngine.color) { render0(); return; }
    moves = moves.slice(0, idx);
    moves.push({ san: m.san, uci: m.uci });
    idx = moves.length;
    playSound(m.captured ? 'capture' : 'move', state.settings.sound);
    render0({ from: m.from, to: m.to });
    if (vsEngine) await engineReply();
  }
  async function engineReply() {
    const c = fenAt(idx);
    if (c.isGameOver() || c.turn() === vsEngine.color || busy) return;
    busy = true; setStatus('Stockfish réfléchit…');
    try {
      const r = await api.play(c.fen(), vsEngine.elo, 700);
      moves.push({ san: r.san, uci: r.uci }); idx = moves.length;
      playSound('move', state.settings.sound);
      render0({ from: r.uci.slice(0, 2), to: r.uci.slice(2, 4) });
      setStatus(`Tu joues contre Stockfish (~${vsEngine.elo} Elo).`);
    } catch (e) { toast(e.message, 'err'); }
    busy = false;
  }
  async function startGame(color) {
    vsEngine = { color, elo: +eloIn.value };
    moves = []; idx = 0; startFen = START_FEN;
    board.setOrientation(color); evalbar.classList.toggle('flip', color === 'b');
    render0(); setStatus(`Tu joues contre Stockfish (~${vsEngine.elo} Elo).`);
    if (color === 'b') await engineReply();
  }

  function loadFen() {
    try { const c = new Chess(fenIn.value.trim()); startFen = c.fen(); moves = []; idx = 0; vsEngine = null; board.setOrientation(c.turn()); render0(); }
    catch { toast('FEN invalide', 'err'); }
  }
  function loadPgn() {
    try {
      const c = new Chess(); c.loadPgn(pgnIn.value);
      const hist = c.history({ verbose: true });
      const hdr = c.header();
      startFen = hdr.FEN || START_FEN;
      moves = hist.map(m => ({ san: m.san, uci: m.from + m.to + (m.promotion || '') }));
      idx = 0; vsEngine = null; render0();
    } catch { toast('PGN invalide', 'err'); }
  }

  // engine
  function ask() { if (engineOn) live.analyze(board.fen, 3); }
  function onLive(msg) {
    lines = msg.lines || [];
    if (!engineOn) return;
    linesBox.innerHTML = '';
    linesBox.append(h('div.small.muted', { style: { marginBottom: '6px' } }, `Profondeur ${msg.depth || '…'}`));
    lines.forEach(l => linesBox.append(h('div.engine-line', h('span.ev.' + (l.cp >= 0 ? 'w' : 'b'), fmtEval(l.cp, l.mate)), h('span.pv', l.pv_san.slice(0, 9).join(' ')))));
    if (lines[0]) {
      const l = lines[0];
      const white = l.mate !== null ? l.mate > 0 : l.cp >= 0;
      evalFill.style.height = (l.mate !== null ? (white ? 100 : 0) : winPct(l.cp)) + '%';
      const whiteBottom = !evalbar.classList.contains('flip');
      evalTop.textContent = ''; evalBot.textContent = '';
      ((white === whiteBottom) ? evalBot : evalTop).textContent = fmtEval(l.cp, l.mate).replace('+', '');
      if (l.pv_uci[0] && !vsEngine) board.setArrows([{ from: l.pv_uci[0].slice(0, 2), to: l.pv_uci[0].slice(2, 4), color: '#5c8bb0' }]);
      else board.setArrows([]);
    }
  }

  const onKey = e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') goto(idx - 1); else if (e.key === 'ArrowRight') goto(idx + 1);
    else if (e.key === 'ArrowUp') goto(0); else if (e.key === 'ArrowDown') goto(moves.length); else if (e.key === 'f') { board.flip(); evalbar.classList.toggle('flip'); }
  };
  window.addEventListener('keydown', onKey);
  render0();
  return () => { window.removeEventListener('keydown', onKey); live.close(); };
}
