import { Chess } from '../../vendor/chess.js';
import { api, LiveEngine } from '../api.js';
import { Board } from '../board.js';
import { state } from '../state.js';
import { h, CLS, TAGS, PHASES, TC, fmtEval, winPct, fmtClock, fmtDate, toast, store, playSound } from '../util.js';

const ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder'];
const BAD = ['inaccuracy', 'mistake', 'blunder'];

function clsDot(cls, size) {
  const c = CLS[cls];
  return h('span.cdot', { style: { background: c.color, width: (size || 22) + 'px', height: (size || 22) + 'px' }, title: c.label }, c.sym);
}

export async function render(root, params) {
  const id = +params.id;
  let g = await api.game(id);
  const cleanups = [];
  if (!g) { root.append(h('div.empty', 'Partie introuvable')); return; }

  // ------------------------------------------------------------ replay positions
  const ch = new Chess();
  const fens = [ch.fen()], infos = [null];
  for (const m of g.moves) {
    const mv = ch.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    infos.push({ from: mv.from, to: mv.to, capture: !!mv.captured, check: ch.inCheck() });
    fens.push(ch.fen());
  }
  const N = g.moves.length;
  const mine = g.user_color || 'w';
  const baseSec = parseInt((g.time_control || '').split('+')[0]) || null;

  const posEval = k => {
    if (!g.analyzed || !N) return null;
    if (k === 0) return { cp: g.moves[0].eval_before, mate: g.moves[0].mate_before };
    const m = g.moves[k - 1];
    return { cp: m.eval_after, mate: m.mate_after };
  };

  // ------------------------------------------------------------ state
  let ply = Math.max(0, Math.min(N, +(params.ply ?? 0)));
  let explore = null;       // {base, chess}
  let retry = null;         // {k, solved}
  let live = null, liveLines = [], tab = store.get('review.tab', 'review');
  let showArrow = store.get('review.arrow', true);

  // ------------------------------------------------------------ DOM
  const boardHost = h('div');
  const evalFill = h('div.fill'), evalTop = h('div.txt.top'), evalBot = h('div.txt.bot');
  const evalbar = h('div.evalbar', evalFill, evalTop, evalBot);
  const strip = (cls) => h('div.pstrip', h('span.pcolor'), h('span.name'), h('span.dim.elo'), h('span.clock'));
  const topStrip = strip(), botStrip = strip();
  const graphHost = h('div');
  const nav = h('div.navbtns',
    h('button.btn.icon', { title: 'Début (↑)', onclick: () => go(0) }, '⏮'),
    h('button.btn.icon', { title: 'Précédent (←)', onclick: () => step(-1) }, '◀'),
    h('button.btn.icon', { title: 'Suivant (→)', onclick: () => step(1) }, '▶'),
    h('button.btn.icon', { title: 'Fin (↓)', onclick: () => go(N) }, '⏭'),
    h('button.btn.icon', { title: 'Retourner (F)', onclick: () => { board.flip(); layoutPlayers(); evalbar.classList.toggle('flip'); } }, '⟲'));
  const left = h('div.boardcol', topStrip, h('div.boardwrap', evalbar, h('div', { style: { flex: 1 } }, boardHost)), botStrip, nav, graphHost);

  const movecard = h('div');
  const banner = h('div');
  const tabsEl = h('div.tabs');
  const panel = h('div');
  const side = h('div', banner, movecard, h('div.sidepanel', tabsEl, panel));
  root.append(h('div.page-head', h('a.btn.sm', { href: '#/games' }, '← Parties'),
    h('div', h('h1', `${g.white} vs ${g.black}`), h('div.muted', `${fmtDate(g.played_at)} · ${TC[g.time_class] || g.time_class} ${g.time_control} · ${g.result} · ${g.opening || 'ouverture inconnue'}`)),
    h('div.right.row', g.url ? h('a.btn.sm', { href: g.url, target: '_blank' }, 'Voir en ligne ↗') : null,
      h('a.btn.sm', { href: `/api/games/${id}/pgn`, download: `partie-${id}.pgn` }, 'PGN'))),
    h('div.review', left, side));

  const board = new Board(boardHost, {
    orientation: mine, interactive: true, movable: 'both', theme: state.settings.board_theme,
    onMove: info => onUserMove(info),
  });
  board.setFen(fens[0]);

  function layoutPlayers() {
    const bottomColor = board.o;
    const set = (el, color) => {
      const w = color === 'w';
      el.querySelector('.pcolor').style.background = w ? '#f5f5f0' : '#262421';
      el.querySelector('.name').textContent = w ? g.white : g.black;
      el.querySelector('.elo').textContent = `(${(w ? g.white_elo : g.black_elo) || '?'})`;
      el._color = color;
    };
    set(topStrip, bottomColor === 'w' ? 'b' : 'w');
    set(botStrip, bottomColor);
    updateClocks();
  }
  function updateClocks() {
    for (const el of [topStrip, botStrip]) {
      let ms = baseSec ? baseSec * 1000 : null;
      for (let i = Math.min(ply, N); i >= 1; i--) {
        const m = g.moves[i - 1];
        if (m.color === el._color && m.clock_ms !== null && m.clock_ms !== undefined) { ms = m.clock_ms; break; }
      }
      el.querySelector('.clock').textContent = explore ? '' : fmtClock(ms);
    }
  }

  // ------------------------------------------------------------ eval bar
  function setEvalBar(cp, mate) {
    if (cp === null || cp === undefined) { evalFill.style.height = '50%'; evalTop.textContent = evalBot.textContent = ''; return; }
    const white = mate !== null && mate !== undefined ? (mate > 0 || (mate === 0 && cp > 0)) : cp >= 0;
    const pct = mate !== null && mate !== undefined ? (white ? 100 : 0) : winPct(cp);
    evalFill.style.height = pct + '%';
    const txt = fmtEval(cp, mate);
    const whiteBottom = !evalbar.classList.contains('flip');
    // text at the side that is "winning"
    evalTop.textContent = ''; evalBot.textContent = '';
    ((white === whiteBottom) ? evalBot : evalTop).textContent = txt.replace('+', '');
  }

  // ------------------------------------------------------------ graph
  function drawGraph() {
    graphHost.innerHTML = '';
    if (!g.analyzed || N < 2) return;
    const W = 600, H = 110;
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none'); svg.classList.add('graph');
    svg.style.marginTop = '10px';
    const pts = [];
    for (let k = 0; k <= N; k++) { const e = posEval(k); const wp = e.mate !== null && e.mate !== undefined ? (e.cp > 0 ? 100 : 0) : winPct(e.cp); pts.push([k / N * W, H - wp / 100 * H]); }
    const area = document.createElementNS(svgNS, 'path');
    area.setAttribute('d', `M0,${H} ` + pts.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ') + ` L${W},${H} Z`);
    area.setAttribute('fill', '#e9e7e0'); area.setAttribute('opacity', '.9');
    svg.append(area);
    const mid = document.createElementNS(svgNS, 'line');
    mid.setAttribute('x1', 0); mid.setAttribute('x2', W); mid.setAttribute('y1', H / 2); mid.setAttribute('y2', H / 2); mid.setAttribute('stroke', '#888'); mid.setAttribute('stroke-dasharray', '3 3'); mid.setAttribute('opacity', .6);
    svg.append(mid);
    g.moves.forEach((m, i) => {
      if (!['blunder', 'mistake', 'brilliant', 'great'].includes(m.cls)) return;
      const c = document.createElementNS(svgNS, 'circle');
      c.setAttribute('cx', pts[i + 1][0]); c.setAttribute('cy', pts[i + 1][1]);
      c.setAttribute('r', m.color === mine ? 4.5 : 3); c.setAttribute('fill', CLS[m.cls].color); c.setAttribute('stroke', '#111'); c.setAttribute('stroke-width', .8);
      svg.append(c);
    });
    const cur = document.createElementNS(svgNS, 'line');
    cur.setAttribute('y1', 0); cur.setAttribute('y2', H); cur.setAttribute('stroke', '#7fa650'); cur.setAttribute('stroke-width', 2);
    svg.append(cur);
    svg._cur = cur;
    svg.addEventListener('click', e => { const r = svg.getBoundingClientRect(); go(Math.round((e.clientX - r.left) / r.width * N)); });
    graphHost.append(svg);
    updateGraphCursor();
  }
  function updateGraphCursor() {
    const svg = graphHost.firstChild;
    if (svg && svg._cur) { const x = (Math.min(ply, N) / N) * 600; svg._cur.setAttribute('x1', x); svg._cur.setAttribute('x2', x); }
  }

  // ------------------------------------------------------------ navigation
  function go(k, silent) {
    if (explore) exitExplore(true);
    if (retry) { retry = null; guided = null; renderBanner(); }
    const prev = ply;
    ply = Math.max(0, Math.min(N, k));
    const hint = ply === prev + 1 ? { from: infos[ply].from, to: infos[ply].to } : undefined;
    board.setFen(fens[ply], hint);
    updateView();
    if (!silent && hint) playSound(infos[ply].capture ? 'capture' : infos[ply].check ? 'check' : 'move', state.settings.sound);
    history.replaceState(null, '', `#/review/${id}?ply=${ply}`);
  }
  const step = d => { if (explore) { exploreBack(); return; } go(ply + d); };

  function updateView() {
    const e = posEval(ply);
    if (e) setEvalBar(e.cp, e.mate); else setEvalBar(null);
    const info = infos[ply];
    board.setLast(info ? info.from : null, info ? info.to : null);
    const m = ply > 0 ? g.moves[ply - 1] : null;
    const notable = m && ['brilliant', 'great', 'inaccuracy', 'mistake', 'blunder'].includes(m.cls);
    board.setBadge(notable && info ? info.to : null, notable ? CLS[m.cls] : null);
    // best-move arrow on the position *before* a questionable move? chess.com shows it after: we show the best move of the previous position
    const arrows = [];
    if (m && showArrow && BAD.includes(m.cls) && m.best_uci) arrows.push({ from: m.best_uci.slice(0, 2), to: m.best_uci.slice(2, 4), color: '#7fa650' });
    board.setArrows(arrows);
    board.setHint(null);
    updateClocks();
    renderMoveCard();
    markCurrentMove();
    updateGraphCursor();
    if (tab === 'engine') askEngine(fens[ply]);
  }

  // ------------------------------------------------------------ move card
  function renderMoveCard() {
    movecard.innerHTML = '';
    if (explore || (retry && !retry.revealed)) return;
    if (retry && retry.revealed) { /* show explanation of the played move */ }
    if (ply === 0) {
      movecard.append(h('div.mcard', h('div.t', 'Position de départ'), h('div.muted', g.analyzed ? 'Utilise ← → pour parcourir la partie, ou saute directement à un moment clé dans l\'onglet « Revue ».' : 'Cette partie n\'est pas encore analysée.')));
      return;
    }
    const m = g.moves[ply - 1];
    const who = m.color === mine ? 'Tu as joué' : 'Ton adversaire a joué';
    if (!m.cls) { movecard.append(h('div.mcard', h('div.t', `${who} ${m.san}`))); return; }
    const c = CLS[m.cls];
    const before = fmtEval(m.eval_before, m.mate_before), after = fmtEval(m.eval_after, m.mate_after);
    const card = h('div.mcard', { style: { borderColor: c.color } },
      h('div.t', clsDot(m.cls), h('span', `${m.san} — ${c.label}`), h('span.right.mono.muted', `${before} → ${after}`)));
    if (BAD.includes(m.cls)) {
      card.append(h('div', `${who} ${m.san}. Le meilleur coup était `, h('b', m.best_san), ` (${before}).`));
      if (m.pv_san) card.append(h('div.small.muted', 'Ligne du moteur : ', m.pv_san));
      const nxt = g.moves[ply];
      if (nxt && nxt.pv_san) card.append(h('div.small.muted', `Après ${m.san}, la suite critique : `, nxt.pv_san));
      if (m.tags.length) card.append(h('div.taglist', m.tags.map(t => h('span.tag', TAGS[t] || t))));
      const btns = h('div.row', { style: { marginTop: '8px' } },
        h('button.btn.sm', { onclick: () => { showArrow = !showArrow; store.set('review.arrow', showArrow); updateView(); } }, showArrow ? 'Masquer la flèche' : 'Voir le meilleur coup'));
      if (m.color === mine) btns.append(h('button.btn.sm.primary', { onclick: () => startRetry(ply) }, '↻ Réessayer ce coup'));
      card.append(btns);
    } else if (m.cls === 'great') {
      card.append(h('div.muted', 'Coup quasi unique : les alternatives perdaient nettement en valeur.'));
    } else if (m.cls === 'brilliant') {
      card.append(h('div.muted', 'Sacrifice juste : tu abandonnes du matériel pour une compensation décisive.'));
    } else if (m.cls === 'book') {
      card.append(h('div.muted', g.opening ? `Théorie : ${g.opening}` : 'Coup de théorie.'));
    } else if (m.cls !== 'best') {
      card.append(h('div.muted', `Meilleur coup : ${m.best_san} (légère perte, ${m.loss}% de probabilité de gain).`));
    }
    if (m.spent_ms !== null && m.spent_ms !== undefined) card.append(h('div.small.dim', { style: { marginTop: '4px' } }, `Temps passé : ${(m.spent_ms / 1000).toFixed(1)} s`));
    movecard.append(card);
  }

  // ------------------------------------------------------------ retry / guided review / explore
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let guided = null;        // {list:[plies], i}
  const X_BADGE = { sym: '✗', color: '#ca3431' };

  function retryHint(m) {
    const t = m.tags || [];
    if (t.includes('mate_missed')) return 'Il existait un mat forcé : cherche les échecs.';
    if (t.includes('missed_fork')) return 'Une fourchette était possible.';
    if (t.includes('missed_material')) return 'Tu pouvais gagner du matériel : regarde les captures.';
    if (t.includes('hung_piece')) return 'Ton coup laisse une pièce en prise : vérifie ce que l\'adversaire peut prendre.';
    if (t.includes('allowed_fork')) return 'Ton coup permet une fourchette adverse.';
    if (t.includes('mate_allowed')) return 'Ton coup permet un mat : pense à la sécurité de ton roi.';
    if (t.includes('threw_advantage')) return 'Tu étais mieux : cherche le coup le plus sûr, pas le plus ambitieux.';
    return 'Cherche dans l\'ordre : échecs, captures, menaces adverses.';
  }

  function renderBanner() {
    banner.innerHTML = '';
    if (retry) {
      const m = g.moves[retry.k - 1];
      const head = guided ? `🧭 Revue guidée — erreur ${guided.i + 1}/${guided.list.length}` : '↻ Réessayer';
      const row = h('div.row', { style: { marginTop: '8px' } });
      if (!retry.revealed) {
        row.append(h('button.btn.sm', { onclick: retryHintClick }, retry.level ? `💡 Indice ${Math.min(3, retry.level + 1)}/3` : '💡 Indice'),
          h('button.btn.sm', { onclick: showSolution }, 'Montrer la solution'));
        if (guided) row.append(h('button.btn.sm', { onclick: guidedNext }, 'Passer →'));
      } else {
        row.append(guided ? h('button.btn.primary', { onclick: guidedNext }, guided.i + 1 < guided.list.length ? 'Erreur suivante →' : 'Terminer la revue ✓') : h('button.btn.primary', { onclick: () => { retry = null; go(retryK(), true); } }, 'Voir dans la partie'));
        row.append(h('button.btn.sm', { onclick: () => startRetry(retry.k, true) }, '↻ Refaire'));
      }
      row.append(h('button.btn.sm', { onclick: () => { retry = null; guided = null; renderBanner(); go(ply, true); } }, 'Quitter'));
      banner.append(h('div.feedback.info', h('div', head), h('div', { style: { fontWeight: 400, marginTop: '4px' } },
        retry.revealed ? `Dans la partie : ${m.san} (${m.loss}% perdus).` : `Position avant ton coup ${Math.ceil(m.ply / 2)}${m.color === 'w' ? '.' : '…'} — trouve un meilleur coup que ${m.san}.`),
        retry.busy ? h('div', { style: { marginTop: '6px' } }, h('span.spinner', { style: { display: 'inline-block', marginRight: '8px' } }), 'Vérification…') : null,
        retry.msg ? h('div', { style: { marginTop: '6px' } }, retry.msg) : null, row));
    } else if (explore) {
      banner.append(h('div.feedback.info.row', h('span', '🔍 Variante libre — joue des coups pour explorer.'),
        h('button.btn.sm.right', { onclick: () => exitExplore(false) }, 'Retour à la partie')));
    }
  }
  const retryK = () => (retry ? retry.k : ply);
  function startRetry(k, again) {
    if (explore) exitExplore(true);
    retry = { k, msg: '', level: 0, busy: false, revealed: false, mistakes: 0 };
    ply = k;
    board.setFen(fens[k - 1]);
    board.setArrows([]); board.setBadge(null); board.setHint(null); board.setLast(null);
    const before = infos[k - 1];
    if (before) board.setLast(before.from, before.to);
    setEvalBar(null);
    updateGraphCursor();
    movecard.innerHTML = '';
    history.replaceState(null, '', `#/review/${id}?ply=${k}`);
    renderBanner();
  }
  function retryHintClick() {
    const m = g.moves[retry.k - 1];
    retry.level = Math.min(3, retry.level + 1);
    if (retry.level === 1) retry.msg = '💡 ' + retryHint(m);
    if (retry.level === 2) { board.setHint(m.best_uci.slice(0, 2)); retry.msg = '💡 Déplace la pièce en surbrillance.'; }
    if (retry.level === 3) { board.setArrows([{ from: m.best_uci.slice(0, 2), to: m.best_uci.slice(2, 4), color: '#5c8bb0' }]); retry.msg = '💡 Voilà le coup : joue-le pour continuer.'; }
    renderBanner();
  }
  function reveal(msg) {
    retry.revealed = true; retry.msg = msg || retry.msg;
    renderBanner(); renderMoveCard();
  }
  async function showSolution() {
    const m = g.moves[retry.k - 1];
    board.setHint(null);
    board.setArrows([{ from: m.best_uci.slice(0, 2), to: m.best_uci.slice(2, 4), color: '#7fa650' }]);
    reveal(`Solution : ${m.best_san}  (${m.pv_san})`);
  }
  async function retryMove(mv) {
    const m = g.moves[retry.k - 1];
    const fenBefore = fens[retry.k - 1];
    if (retry.busy || retry.revealed) { board.setFen(fenBefore); return; }
    retry.busy = true;
    board.play(mv.uci); board.setHint(null); board.setArrows([]);
    renderBanner();
    try {
      // the engine's stored best move is accepted instantly; anything else is checked by Stockfish
      const r = mv.uci === m.best_uci
        ? { ok: true, exact: true, san: mv.san, loss: 0, best_san: m.best_san }
        : await api.checkMove(fenBefore, mv.uci);
      if (r.ok) {
        playSound('ok', state.settings.sound);
        retry.busy = false;
        board.setBadge(mv.to, { sym: '✓', color: '#7fa650' });
        reveal(`✅ ${r.san} ${r.exact ? 'est le meilleur coup !' : `est un bon coup (perte ${r.loss}%) — le moteur préfère ${r.best_san}.`}`);
        return;
      }
      retry.mistakes++;
      playSound('error', state.settings.sound);
      retry.msg = `❌ ${r.san} n'est pas assez bon (−${r.loss}%).` + (r.refutation ? ` Réponse du moteur : ${r.refutation}.` : '') + (retry.mistakes >= 2 ? ' Utilise un indice si tu veux.' : ' Réessaie !');
      board.setBadge(mv.to, X_BADGE);
      retry.busy = false; renderBanner();
      await sleep(850);
      if (retry && !retry.revealed) { board.setBadge(null); board.setFen(fenBefore); board.setLast(infos[retry.k - 1]?.from, infos[retry.k - 1]?.to); }
    } catch (e) {
      toast(e.message, 'err');
      if (retry) { retry.busy = false; board.setFen(fenBefore); renderBanner(); }
    }
  }

  // guided review: walk through my mistakes one by one
  function guidedList() {
    return g.moves.filter(m => m.color === mine && !m.is_book && (m.cls === 'blunder' || m.cls === 'mistake' || (m.cls === 'inaccuracy' && (m.tags || []).includes('mate_missed'))))
      .sort((a, b) => b.loss - a.loss).slice(0, 8).sort((a, b) => a.ply - b.ply).map(m => m.ply);
  }
  function startGuided() {
    const list = guidedList();
    if (!list.length) { toast('Aucune erreur à revoir dans cette partie 👏', 'ok'); finishGuided(true); return; }
    guided = { list, i: 0 };
    startRetry(list[0]);
  }
  async function guidedNext() {
    if (!guided) return;
    guided.i++;
    if (guided.i >= guided.list.length) { finishGuided(); return; }
    startRetry(guided.list[guided.i]);
  }
  async function finishGuided(silent) {
    const had = guided;
    guided = null; retry = null; renderBanner();
    try { await api.gameMeta(id, { reviewed: 1 }); g.reviewed = 1; await api.dailyLog('review'); } catch (e) { /* ignore */ }
    go(ply, true);
    if (!silent && had) toast(`Revue guidée terminée : ${had.list.length} moments clés travaillés ✅`, 'ok');
  }

  async function onUserMove(mv) {
    if (retry) { retryMove(mv); return; }
    // Following the game's own next move just advances
    if (!explore && ply < N && g.moves[ply].uci === mv.uci) { go(ply + 1); return; }
    if (!explore) {
      explore = { base: ply, chess: new Chess(fens[ply]) };
      renderBanner(); movecard.innerHTML = ''; board.setBadge(null); board.setArrows([]);
    }
    board.play(mv.uci);
    explore.chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    playSound(mv.captured ? 'capture' : 'move', state.settings.sound);
    setEvalBar(null);
    if (tab !== 'engine') setTab('engine'); else askEngine(board.fen);
  }
  function exploreBack() {
    explore.chess.undo();
    if (explore.chess.history().length === 0) { exitExplore(false); return; }
    board.setFen(explore.chess.fen());
    askEngine(board.fen);
  }
  function exitExplore(silent) {
    explore = null; renderBanner();
    if (!silent) { board.setFen(fens[ply]); updateView(); }
  }

  // ------------------------------------------------------------ engine tab
  function ensureLive() {
    if (!live) live = new LiveEngine(onLive);
    live.setEnabled(true);
  }
  function askEngine(fen) { if (live) live.analyze(fen, 3); }
  function onLive(msg) {
    liveLines = msg.lines || [];
    if (tab === 'engine') drawEngine(msg);
    if (explore && liveLines[0]) {
      setEvalBar(liveLines[0].cp, liveLines[0].mate);
      if (showArrow && liveLines[0].pv_uci[0]) board.setArrows([{ from: liveLines[0].pv_uci[0].slice(0, 2), to: liveLines[0].pv_uci[0].slice(2, 4), color: '#5c8bb0' }]);
    }
  }
  const engineBox = h('div');
  function drawEngine(msg) {
    engineBox.innerHTML = '';
    engineBox.append(h('div.row.small.muted', { style: { marginBottom: '8px' } }, `Stockfish · profondeur ${msg?.depth ?? '…'}`,
      h('label.switch.right', h('input', { type: 'checkbox', checked: showArrow, onchange: e => { showArrow = e.target.checked; store.set('review.arrow', showArrow); updateView(); } }), 'Flèche')));
    if (!liveLines.length) { engineBox.append(h('div.muted', 'Calcul…')); return; }
    const sideToMove = (explore ? explore.chess : new Chess(fens[ply])).turn();
    liveLines.forEach(l => {
      engineBox.append(h('div.engine-line', h('span.ev.' + (l.cp >= 0 ? 'w' : 'b'), fmtEval(l.cp, l.mate)), h('span.pv', l.pv_san.slice(0, 8).join(' '))));
    });
  }

  // ------------------------------------------------------------ tabs
  function setTab(t) {
    tab = t; store.set('review.tab', t);
    tabsEl.innerHTML = '';
    [['review', 'Revue'], ['moves', 'Coups'], ['engine', 'Moteur'], ['notes', 'Notes']].forEach(([k, l]) =>
      tabsEl.append(h('div.tab' + (tab === k ? '.on' : ''), { onclick: () => setTab(k) }, l)));
    panel.innerHTML = '';
    if (t === 'review') drawReview();
    else if (t === 'moves') drawMoves();
    else if (t === 'engine') { ensureLive(); panel.append(engineBox); drawEngine(); askEngine(explore ? board.fen : fens[ply]); }
    else drawNotes();
  }

  function countBy(color) {
    const c = {};
    g.moves.filter(m => m.color === color && m.cls).forEach(m => { c[m.cls] = (c[m.cls] || 0) + 1; });
    return c;
  }
  function drawReview() {
    if (!g.analyzed) {
      const btn = h('button.btn.primary', { onclick: async () => { await api.analyze({ ids: [id], force: true }); toast('Analyse lancée', 'ok'); poll(); } }, '⚡ Analyser cette partie');
      panel.append(h('div.empty', h('p', 'Cette partie n\'a pas encore été analysée par Stockfish.'), btn));
      return;
    }
    const co = g.coach, accW = g.acc_white, accB = g.acc_black;
    const cw = countBy('w'), cb = countBy('b');
    panel.append(h('div.row', { style: { justifyContent: 'space-around', marginBottom: '14px' } },
      ...[['w', g.white, accW, g.acpl_white], ['b', g.black, accB, g.acpl_black]].map(([c, n, a, acpl]) =>
        h('div', { style: { textAlign: 'center' } }, h('div.small.muted', n + (c === mine ? ' (toi)' : '')), h('div', { style: { fontSize: '30px', fontWeight: 800 }, class: c === mine ? (a >= 80 ? 'good' : a < 65 ? 'bad' : '') : '' }, a ?? '–'), h('div.small.dim', `Précision · ACPL ${acpl ?? '–'}`)))));
    const tb = h('table', h('thead', h('tr', h('th', ''), h('th', g.white), h('th', g.black))));
    const tbd = h('tbody');
    ORDER.forEach(k => { if (cw[k] || cb[k]) tbd.append(h('tr', h('td', h('div.row', clsDot(k, 18), CLS[k].label)), h('td', cw[k] || 0), h('td', cb[k] || 0))); });
    tb.append(tbd);
    panel.append(tb);
    if (guidedList().length) panel.append(h('div', { style: { margin: '14px 0 4px' } }, h('button.btn.primary', { onclick: startGuided }, `🧭 Lancer la revue guidée (${guidedList().length} moments clés)`), h('div.small.muted', { style: { marginTop: '4px' } }, 'Pour chaque grosse erreur : la position avant ton coup, tu cherches le bon coup (avec indices), puis explication.')));
    if (co) {
      panel.append(h('h3', { style: { marginTop: '16px' } }, 'Bilan du coach'));
      co.lines.forEach(l => panel.append(h('p', { style: { margin: '4px 0' } }, l)));
      const ph = Object.entries(co.phases);
      if (ph.length) panel.append(h('div.row', { style: { marginTop: '8px' } }, ph.map(([k, v]) => h('span.tag', `${PHASES[k]} : ${v.accuracy}% · ${v.errors} err.`))));
      const mom = g.moves.filter(m => m.color === mine && ['mistake', 'blunder'].includes(m.cls));
      panel.append(h('h3', { style: { marginTop: '16px' } }, `Moments clés (${mom.length})`));
      if (!mom.length) panel.append(h('div.muted', 'Aucune erreur ni gaffe 👏'));
      mom.forEach(m => panel.append(h('div.moment', { onclick: () => go(m.ply) }, clsDot(m.cls),
        h('div', { style: { flex: 1 } }, h('b', `${Math.ceil(m.ply / 2)}${m.color === 'w' ? '.' : '...'} ${m.san}`), h('span.muted', ` → meilleur ${m.best_san}`),
          m.tags.length ? h('div.taglist', m.tags.map(t => h('span.tag', TAGS[t] || t))) : null),
        h('span.mono.muted', `-${m.loss}%`))));
    }
  }
  function drawMoves() {
    const list = h('div.movelist');
    for (let i = 0; i < N; i += 2) {
      list.append(h('div.no', Math.floor(i / 2) + 1 + '.'));
      for (const k of [i, i + 1]) {
        const m = g.moves[k];
        if (!m) { list.append(h('div')); continue; }
        const c = m.cls && !['best', 'excellent', 'good', 'book'].includes(m.cls) ? CLS[m.cls] : null;
        list.append(h('div.mv', { 'data-ply': k + 1, onclick: () => go(k + 1) }, m.san, c ? h('span.sym', { style: { color: c.color } }, c.sym) : null));
      }
    }
    panel.append(list);
    markCurrentMove();
  }
  function markCurrentMove() {
    panel.querySelectorAll('.mv').forEach(el => {
      const on = +el.dataset.ply === ply && !explore;
      el.classList.toggle('cur', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    });
  }
  function drawNotes() {
    const ta = h('textarea', { rows: 8, placeholder: 'Ce que j\'ai appris dans cette partie, idées à retenir, plans…' }, g.notes || '');
    ta.addEventListener('blur', async () => { await api.gameMeta(id, { notes: ta.value }); g.notes = ta.value; toast('Notes enregistrées', 'ok'); });
    panel.append(ta, h('div.row', { style: { marginTop: '10px' } },
      h('label.switch', h('input', { type: 'checkbox', checked: !!g.starred, onchange: e => api.gameMeta(id, { starred: e.target.checked ? 1 : 0 }) }), '★ Favori'),
      h('label.switch', h('input', { type: 'checkbox', checked: !!g.reviewed, onchange: e => api.gameMeta(id, { reviewed: e.target.checked ? 1 : 0 }) }), 'Revue terminée'),
      h('button.btn.sm.danger.right', { onclick: async () => { if (confirm('Supprimer cette partie ?')) { await api.deleteGame(id); location.hash = '#/games'; } } }, 'Supprimer')));
  }

  // ------------------------------------------------------------ analysis polling when not analysed
  let pollT = null;
  function poll() {
    clearInterval(pollT);
    pollT = setInterval(async () => {
      const gg = await api.game(id);
      if (gg.analyzed) { clearInterval(pollT); location.reload(); }
    }, 3000);
  }
  cleanups.push(() => clearInterval(pollT));

  // ------------------------------------------------------------ keys
  const onKey = e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') { step(-1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { step(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { go(0); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { go(N); e.preventDefault(); }
    else if (e.key === 'f') { board.flip(); layoutPlayers(); evalbar.classList.toggle('flip'); }
  };
  window.addEventListener('keydown', onKey);
  cleanups.push(() => window.removeEventListener('keydown', onKey));
  cleanups.push(() => live && live.close());

  if (mine === 'b') evalbar.classList.add('flip');
  layoutPlayers();
  drawGraph();
  setTab(tab);
  go(ply, true);
  if (!g.analyzed) poll();
  else if (params.guided) startGuided();
  return () => cleanups.forEach(f => f());
}
