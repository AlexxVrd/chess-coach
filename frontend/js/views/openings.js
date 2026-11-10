import { Chess } from '../../vendor/chess.js';
import { api } from '../api.js';
import { Board, START_FEN } from '../board.js';
import { state } from '../state.js';
import { h, store, TC, playSound } from '../util.js';

export async function render(root) {
  const f = { color: store.get('op.color', 'w'), tc: store.get('op.tc', '') };
  const chess = new Chess();
  let path = [];   // SAN list from the start
  let board;

  const boardHost = h('div');
  const crumbs = h('div.row', { style: { margin: '8px 0', minHeight: '28px' } });
  const nameEl = h('div', { style: { fontWeight: 700, fontSize: '16px' } }, 'Position de départ');
  const exploreCard = h('div.card');
  const tableCard = h('div.card');
  const leaksCard = h('div.card');

  const colorChips = h('div.chips');
  const tcChips = h('div.chips');
  function drawChips() {
    colorChips.innerHTML = ''; tcChips.innerHTML = '';
    [['w', '♔ Blancs'], ['b', '♚ Noirs']].forEach(([k, l]) => colorChips.append(h('div.chip' + (f.color === k ? '.on' : ''), { onclick: () => { f.color = k; store.set('op.color', k); reset(); drawChips(); loadTable(); } }, l)));
    [['', 'Toutes'], ['rapid', 'Rapide'], ['blitz', 'Blitz'], ['bullet', 'Bullet']].forEach(([k, l]) => tcChips.append(h('div.chip' + (f.tc === k ? '.on' : ''), { onclick: () => { f.tc = k; store.set('op.tc', k); drawChips(); refresh(); loadTable(); } }, l)));
  }

  root.append(
    h('div.page-head', h('div', h('h1', 'Ouvertures'), h('div.muted', 'Explore ton répertoire réel : ce que tu joues, ce que tes adversaires répondent, et ce que ça te coûte.')),
      h('div.right.row', colorChips, tcChips)),
    h('div.review',
      h('div.boardcol', boardHost, crumbs),
      h('div', h('div.card', nameEl, h('div.small.muted', { id: 'ecoline' }, ''), exploreCard))),
    h('div.grid.g2', { style: { marginTop: '14px' } }, tableCard, leaksCard));

  board = new Board(boardHost, {
    orientation: f.color, interactive: true, movable: 'both', theme: state.settings.board_theme,
    onMove: m => { chess.move({ from: m.from, to: m.to, promotion: m.promotion }); path.push(m.san); board.play(m.uci); playSound('move', state.settings.sound); refresh(); },
  });

  function reset() { chess.reset(); path = []; board.setOrientation(f.color); board.setFen(START_FEN); board.setLast(null); refresh(); }
  function setPath(n) {
    const sans = path.slice(0, n);
    chess.reset(); path = [];
    let last = null;
    for (const s of sans) { last = chess.move(s); path.push(s); }
    board.setFen(chess.fen()); board.setLast(last?.from, last?.to);
    refresh();
  }

  async function refresh() {
    crumbs.innerHTML = '';
    crumbs.append(h('button.btn.sm', { onclick: reset }, '⟲ Départ'), h('button.btn.sm', { disabled: !path.length, onclick: () => setPath(path.length - 1) }, '◀'));
    path.forEach((s, i) => crumbs.append(h('span.chip', { onclick: () => setPath(i + 1) }, (i % 2 === 0 ? Math.floor(i / 2) + 1 + '. ' : '') + s)));
    const fen = chess.fen();
    const info = await api.fenInfo(fen);
    const ex = await api.explorer({ fenkey: info.fenkey, color: f.color, tc: f.tc });
    nameEl.textContent = info.opening || (path.length ? 'Hors théorie' : 'Position de départ');
    document.getElementById('ecoline').textContent = info.eco ? `ECO ${info.eco}` : '';
    exploreCard.innerHTML = '';
    const mine = ex.mine;
    exploreCard.append(h('h3', mine ? `Tes coups ici (${f.color === 'w' ? 'Blancs' : 'Noirs'})` : 'Réponses de tes adversaires'));
    if (!ex.moves.length) { exploreCard.append(h('div.muted', 'Aucune de tes parties ne passe par cette position.')); return; }
    const tb = h('table', h('thead', h('tr', ['Coup', 'Parties', 'Résultats', 'Score', mine ? 'Perte moy.' : '', 'Moteur'].map(t => h('th', t)))));
    const body = h('tbody');
    ex.moves.slice(0, 14).forEach(m => {
      const n = m.n;
      const pc = k => (100 * (m[k] || 0) / n).toFixed(0) + '%';
      const bad = mine && m.avg_loss !== null && m.avg_loss >= 8;
      body.append(h('tr.click', { onclick: () => { chess.move(m.san); path.push(m.san); const mv = board.play(m.uci); playSound('move', state.settings.sound); refresh(); } },
        h('td', h('b', m.san)),
        h('td', `${n} `, h('span.dim', `(${m.pct}%)`)),
        h('td', { style: { width: '140px' } }, h('div.wdl', h('i.w', { style: { width: pc('w') } }), h('i.d', { style: { width: pc('d') } }), h('i.l', { style: { width: pc('l') } }))),
        h('td', { class: m.score >= 55 ? 'good' : m.score < 40 ? 'bad' : '' }, m.score + '%'),
        h('td', mine ? (m.avg_loss !== null ? h('span', { class: bad ? 'bad' : 'muted' }, m.avg_loss + '%') : h('span.dim', '–')) : ''),
        h('td.muted', m.best_san && m.best_san !== m.san && mine ? 'préf. ' + m.best_san : (m.best_san === m.san ? '✓' : ''))));
    });
    tb.append(body);
    exploreCard.append(tb, h('div.small.dim', { style: { marginTop: '8px' } }, `${ex.total} parties passent ici. « Perte moy. » = probabilité de gain perdue en moyenne avec ce coup (parties analysées).`));
  }

  async function loadTable() {
    const ops = await api.openings({ color: f.color, tc: f.tc });
    tableCard.innerHTML = '';
    tableCard.append(h('h2', `Bilan par ouverture (${f.color === 'w' ? 'Blancs' : 'Noirs'})`));
    if (!ops.length) tableCard.append(h('div.muted', 'Pas de données.'));
    else {
      const tb = h('table', h('thead', h('tr', ['Ouverture', 'Parties', 'Résultats', 'Score', 'Préc.', 'Théorie'].map(t => h('th', t)))));
      const body = h('tbody');
      ops.slice(0, 25).forEach(o => body.append(h('tr', h('td', h('b', o.opening), h('span.dim', ` ${o.eco}`)), h('td', o.games),
        h('td', { style: { width: '110px' } }, h('div.wdl', h('i.w', { style: { width: 100 * o.win / o.games + '%' } }), h('i.d', { style: { width: 100 * o.draw / o.games + '%' } }), h('i.l', { style: { width: 100 * o.loss / o.games + '%' } }))),
        h('td', { class: o.score >= 55 ? 'good' : o.score < 40 ? 'bad' : '' }, o.score + '%'), h('td.muted', o.avg_accuracy ?? '–'), h('td.muted', `${o.avg_book} coups`))));
      tb.append(body); tableCard.append(tb);
    }
    const leaks = await api.leaks({ color: f.color, tc: f.tc });
    leaksCard.innerHTML = '';
    leaksCard.append(h('h2', '🕳 Fuites d\'ouverture'), h('div.small.muted', { style: { marginBottom: '8px' } }, 'Coups que tu rejoues et qui te coûtent cher (≥ 2 occurrences, perte moyenne ≥ 8 %). À corriger en priorité.'));
    if (!leaks.length) leaksCard.append(h('div.muted', 'Rien de récurrent détecté (ou pas assez de parties analysées).'));
    leaks.forEach(l => leaksCard.append(h('div.moment', { onclick: () => {
      chess.load(l.fen_before); path = []; board.setOrientation(f.color); board.setFen(l.fen_before); board.setLast(null); crumbs.innerHTML = ''; refresh(); window.scrollTo({ top: 0, behavior: 'smooth' });
    } },
      h('div', { style: { flex: 1 } }, h('b', l.san), h('span.muted', ` → préférable : ${l.best_san || '?'}`), h('div.small.dim', `${l.n} fois · perte moy. ${l.avg_loss.toFixed(1)}% · ${l.w}V/${l.l}D`)),
      h('span.btn.sm', 'Voir'))));
  }

  drawChips();
  await refresh();
  await loadTable();
}
