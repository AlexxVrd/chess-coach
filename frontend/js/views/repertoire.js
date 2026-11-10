import { Chess } from '../../vendor/chess.js';
import { api } from '../api.js';
import { Board, START_FEN } from '../board.js';
import { state } from '../state.js';
import { h, CLS, TC, fmtEval, fmtDate, resultBadge, sleep, store, toast, playSound } from '../util.js';

const NAG_CLS = { '??': 'blunder', '?': 'mistake', '?!': 'inaccuracy', '!': 'great', '!!': 'brilliant', '!?': 'good' };
const NAG_LABEL = { '??': 'Gaffe', '?': 'Erreur', '?!': 'Imprécision', '!': 'Bon coup', '!!': 'Coup brillant', '!?': 'Intéressant' };

export async function render(root, params) {
  let reps = await api.repertoires();
  if (!reps.length) {
    root.append(h('div.empty', 'Aucun répertoire trouvé dans data/repertoires/.'));
    return;
  }
  let rid = params.id || store.get('rep.id', reps[0].id);
  if (!reps.some(r => r.id === rid)) rid = reps[0].id;
  let tab = store.get('rep.tab', 'explore');
  let data = null, byId = {}, trail = [];
  let openSet = new Set(), expandAll = false;
  let drill = null, drillToken = 0, waiting = null;
  let trainMode = store.get('rep.mode', 'due'), trainBranch = false;
  let pollTimer = null;

  // ------------------------------------------------------------ DOM
  const repChips = h('div.chips');
  const tabsEl = h('div.tabs');
  const boardHost = h('div');
  const crumbs = h('div.row', { style: { margin: '8px 0', minHeight: '28px' } });
  const nav = h('div.navbtns',
    h('button.btn.icon', { title: 'Début (↑)', onclick: () => goRoot() }, '⏮'),
    h('button.btn.icon', { title: 'Retour (←)', onclick: () => back() }, '◀'),
    h('button.btn.icon', { title: 'Coup principal (→)', onclick: () => forward() }, '▶'),
    h('button.btn.icon', { title: 'Retourner (F)', onclick: () => board.flip() }, '⟲'));
  const side = h('div');
  const bottom = h('div', { style: { marginTop: '14px' } });
  const headSub = h('div.muted');
  root.append(
    h('div.page-head', h('div', h('h1', 'Répertoire'), headSub), h('div.right', repChips)),
    tabsEl,
    h('div.review', h('div.boardcol', boardHost, crumbs, nav), side),
    bottom);

  const board = new Board(boardHost, { interactive: true, movable: 'both', theme: state.settings.board_theme, onMove: m => onBoardMove(m) });

  // ------------------------------------------------------------ helpers
  const node = id => byId[id];
  const cur = () => node(trail.length ? trail[trail.length - 1] : 0);
  const next = n => (n.ch.length ? n.ch : (n.tr != null ? node(n.tr).ch : [])).map(node);
  const turnOf = n => n.fen.split(' ')[1];
  const ourTurn = n => turnOf(n) === data.color;
  const mainMove = n => next(n).find(c => c.ours && !c.alt);
  const num = (n, force) => {
    const p = node(n.p);
    const [, t, , , , full] = p.fen.split(' ');
    return t === 'w' ? `${full}.` : (force ? `${full}…` : '');
  };
  const label = n => `${num(n, true)} ${n.san}`;
  const pathText = ids => ids.map((id, i) => { const n = node(id); const no = num(n, i === 0); return (no ? no + ' ' : '') + n.san; }).join(' ');
  const pos = n => data.report.pos[n.id] || null;
  const firstSentence = s => (s || '').split(/(?<=[.!?:])\s/)[0];
  const evChip = n => n.cp == null && n.mate == null ? null
    : h('span.evchip.ev.' + ((n.mate ?? n.cp) >= 0 ? 'w' : 'b'), fmtEval(n.cp, n.mate));
  const nagEl = nag => nag ? h('span.nag', { style: { color: CLS[NAG_CLS[nag]]?.color } }, nag) : null;
  function openingName() {
    for (let i = trail.length - 1; i >= 0; i--) { const n = node(trail[i]); if (n.opening) return `${n.opening} (${n.eco})`; }
    return data.title;
  }

  // ------------------------------------------------------------ loading
  async function load(keepTrail) {
    const prev = keepTrail ? trail.slice() : null;
    data = await api.repertoire(rid);
    byId = Object.fromEntries(data.nodes.map(n => [n.id, n]));
    trail = prev && prev.every(id => byId[id]) ? prev : [];
    if (!keepTrail) { openSet = new Set(); board.setOrientation(data.color); }
    headSub.textContent = data.description;
    clearTimeout(pollTimer);
    if (data.evals.running) schedulePoll();
  }

  // while Stockfish annotates the tree in the background, refresh the explorer (never in the middle of a drill)
  function schedulePoll() {
    pollTimer = setTimeout(async () => {
      if (tab === 'train') return schedulePoll();
      await load(true);
      draw();
    }, 6000);
  }

  function drawChips() {
    repChips.innerHTML = '';
    reps.forEach(r => repChips.append(h('div.chip.repchip' + (r.id === rid ? '.on' : ''), {
      onclick: async () => { if (r.id === rid) return; rid = r.id; store.set('rep.id', rid); stopDrill(); await load(); drawChips(); draw(); },
    }, (r.color === 'w' ? '♔ ' : '♚ ') + r.title, r.due ? h('small', `· ${r.due} à revoir`) : null)));
    tabsEl.innerHTML = '';
    [['explore', '🌳 Explorer l\'arbre'], ['train', '🎯 S\'entraîner'], ['games', '♟ Mes parties']].forEach(([k, l]) =>
      tabsEl.append(h('div.tab' + (tab === k ? '.on' : ''), { onclick: () => { if (tab === k) return; tab = k; store.set('rep.tab', k); stopDrill(); drawChips(); draw(); } }, l)));
  }

  function draw() {
    side.innerHTML = ''; bottom.innerHTML = '';
    board.setArrows([]); board.setHint(null);
    if (tab === 'train') { drawTrain(); startLine(); return; }
    if (tab === 'games') { drawGames(); return showNode(false); }
    showNode(false);
  }

  // ------------------------------------------------------------ navigation (explorer)
  function goTo(id, animate) {
    const n = node(id);
    const path = [];
    for (let x = n; x && x.p != null; x = node(x.p)) path.unshift(x.id);
    trail = path;
    showNode(animate);
  }
  function step(child) { trail.push(child.id); showNode(true); }
  function back() { if (drill) return; if (trail.length) { trail.pop(); showNode(false); } }
  function goRoot() { if (drill) return; trail = []; showNode(false); }
  function forward() {
    if (drill) return;
    const n = cur();
    const c = ourTurn(n) ? mainMove(n) : next(n)[0];
    if (c) step(c);
  }

  function showNode(animate) {
    const n = cur();
    if (animate && n.uci) board.setFen(n.fen, { from: n.uci.slice(0, 2), to: n.uci.slice(2, 4) });
    else board.setFen(n.fen);
    board.setLast(n.uci ? n.uci.slice(0, 2) : null, n.uci ? n.uci.slice(2, 4) : null);
    board.opts.movable = 'both';
    const kids = next(n);
    if (ourTurn(n)) {
      board.setArrows(kids.filter(c => c.ours).map(c => ({ from: c.uci.slice(0, 2), to: c.uci.slice(2, 4), color: c.alt ? '#5c8bb0' : '#7fa650', opacity: c.alt ? 0.55 : 0.85 })));
    } else {
      board.setArrows(kids.map(c => ({ from: c.uci.slice(0, 2), to: c.uci.slice(2, 4), color: ['?', '??'].includes(c.nag) ? '#ca3431' : '#9a958b', opacity: 0.6, width: 0.1 })));
    }
    drawCrumbs();
    if (tab === 'explore') drawExplore();
    if (tab === 'games') { /* board follows clicks from the games tab */ }
  }

  function drawCrumbs() {
    crumbs.innerHTML = '';
    if (drill) return;
    crumbs.append(h('button.btn.sm', { onclick: goRoot }, '⟲ Départ'));
    trail.forEach((id, i) => {
      const n = node(id);
      const no = num(n, i === 0);
      crumbs.append(h('span.chip', { onclick: () => { trail = trail.slice(0, i + 1); showNode(false); } }, (no ? no + ' ' : '') + n.san));
    });
  }

  function onBoardMove(m) {
    if (tab === 'train') return onDrillMove(m);
    const n = cur();
    const hit = next(n).find(c => c.uci === m.uci);
    if (hit) { playSound('move', state.settings.sound); step(hit); return; }
    toast(`${m.san} n'est pas dans le répertoire`, 'err');
    board.setFen(n.fen);
  }

  // ------------------------------------------------------------ explorer panel
  function drawExplore() {
    side.innerHTML = '';
    const n = cur();
    const kids = next(n);
    const info = h('div.card');
    info.append(h('div.row', h('div', { style: { fontWeight: 700, fontSize: '16px' } }, trail.length ? openingName() : data.title), h('div.right', evChip(n))));
    if (!trail.length) info.append(h('div.small.muted', { style: { marginTop: '6px' } }, data.description));
    if (n.san) {
      const bad = !n.ours && ['?', '??', '?!'].includes(n.nag);
      info.append(h('div.mcard', { style: { marginTop: '10px', borderLeftColor: bad ? CLS[NAG_CLS[n.nag]].color : n.ours ? 'var(--accent)' : 'var(--fg3)' } },
        h('div.t', label(n), nagEl(n.nag), h('span.small.muted', n.ours ? (n.alt ? 'variante acceptée' : 'ton coup') : 'coup adverse'),
          bad && n.loss != null ? h('span.small.bad', `−${n.loss}% pour l'adversaire`) : null),
        n.c ? h('div', n.c) : h('div.dim.small', n.ours ? 'Coup du répertoire.' : 'Réponse adverse prévue par le répertoire.')));
    }
    side.append(info);

    const nextCard = h('div.card');
    side.append(nextCard);
    if (!kids.length) {
      nextCard.append(h('h3', 'Fin de la préparation'),
        h('div.muted', n.ours || ourTurn(n) ? 'Tu connais la ligne jusqu\'ici : joue maintenant selon les plans indiqués dans les commentaires.' : 'Fin de la ligne.'));
      if (n.best) nextCard.append(h('div.small.dim', { style: { marginTop: '6px' } }, `Suite moteur : ${n.best}`));
    } else if (ourTurn(n)) {
      const main = mainMove(n);
      const alts = kids.filter(c => c.alt);
      nextCard.append(h('h3', 'Ton coup'),
        h('div.reply', { onclick: () => step(main) }, h('span.bigmove', label(main)), h('span.why', main.c || ''), h('span.ans', '▶')));
      alts.forEach(a => nextCard.append(h('div.reply', { onclick: () => step(a) },
        h('span.mv1.muted', label(a)), h('span.why', a.c || 'Aussi accepté.'), h('span.small.dim', 'accepté'))));
      if (n.best && n.best !== main.san && !alts.some(a => a.san === n.best))
        nextCard.append(h('div.small.dim', { style: { marginTop: '4px' } }, `Stockfish préfère ${n.best} ici, mais ${main.san} reste dans l'esprit du répertoire.`));
      const p = pos(n);
      if (p) {
        const played = Object.entries(p.moves).map(([san, c]) => {
          const k = kids.find(x => x.san === san);
          const tag = k ? (k.alt ? ' (accepté)' : ' ✓') : ' ✗';
          return h('span', { class: k ? 'good' : 'bad' }, `${san} ×${c}${tag}`);
        });
        nextCard.append(h('div.small', { style: { marginTop: '10px' } }, h('span.muted', `Dans tes parties (${p.n}×, score ${score(p)}%) : `), ...played.flatMap((e, i) => i ? [' · ', e] : [e])));
      }
    } else {
      const p = pos(n);
      nextCard.append(h('h3', 'Ce que l\'adversaire peut jouer'), h('div.small.dim', { style: { marginBottom: '8px' } }, 'Pour chaque coup adverse, la réponse du répertoire (en vert). Clique pour avancer.'));
      const freq = c => (p && p.moves[c.san]) || 0;
      [...kids].sort((a, b) => freq(b) - freq(a)).forEach(c => {
        const ans = mainMove(c);
        const f = freq(c);
        nextCard.append(h('div.reply', { onclick: () => step(c) },
          h('span.mv1', label(c), nagEl(c.nag)),
          h('span.why', firstSentence(c.c) || (c.nag ? NAG_LABEL[c.nag] + (c.loss != null ? ` (−${c.loss}%)` : '') : '')),
          f ? h('span.small.muted', `${f}× dans tes parties`) : null,
          h('span.ans', ans ? '→ ' + ans.san : next(c).length ? '…' : '')));
      });
      const holes = data.report.holes.filter(x => x.node === n.id);
      if (holes.length) {
        nextCard.append(h('h3', { style: { marginTop: '14px' } }, 'Rencontré dans tes parties, pas encore préparé'));
        holes.forEach(x => nextCard.append(holeRow(n, x)));
      }
    }
    drawTree();
  }
  const score = p => Math.round(100 * (p.w + 0.5 * p.d) / Math.max(1, p.w + p.d + p.l));

  function holeRow(n, x) {
    const out = h('span.ans');
    return h('div.reply', { onclick: async () => {
      const ch = new Chess(n.fen);
      ch.move({ from: x.uci.slice(0, 2), to: x.uci.slice(2, 4), promotion: x.uci[4] });
      out.textContent = '…';
      try { const r = await api.bestMove(ch.fen()); out.textContent = '→ ' + r.san + ' (Stockfish)'; } catch (e) { out.textContent = '?'; }
    } }, h('span.mv1.bad', `${num({ p: n.id }, true)} ${x.san}`), h('span.why', `${x.n}× · clique pour la réponse de Stockfish`), out);
  }

  // ------------------------------------------------------------ the tree
  function drawTree() {
    const onTrail = new Set(trail);
    const box = h('div.reptree');
    const card = h('div.card', h('div.row', h('h2', { style: { margin: 0 } }, 'Arbre complet'),
      h('span.small.dim', `${data.positions} positions · vert = tes coups`),
      data.evals.running ? h('span.small.muted.row', { style: { gap: '6px' } }, h('div.spinner'), `Stockfish annote l'arbre (${data.evals.done}/${data.evals.total})`) : null,
      h('div.right.row', h('button.btn.sm', { onclick: () => { expandAll = true; drawTree(); } }, 'Tout déplier'),
        h('button.btn.sm', { onclick: () => { expandAll = false; openSet.clear(); drawTree(); } }, 'Replier'))), box);
    const mv = (n, first) => {
      const el = h('span.tmv' + (n.ours ? (n.alt ? '.alt' : '.ours') : '') + (n.id === cur().id ? '.cur' : ''),
        { onclick: e => { e.stopPropagation(); goTo(n.id); } }, n.san, nagEl(n.nag));
      const no = num(n, first);
      return no ? [h('span.tno', no), el] : [el];
    };
    // one line of moves until the opponent has a choice, then one indented branch per opponent reply
    function lineFrom(n, container, first) {
      const row = h('div.tline');
      container.append(row);
      let x = n, f = first;
      for (;;) {
        row.append(...mv(x, f));
        f = false;
        const kids = x.ch.map(node);
        const alts = kids.filter(c => c.alt);
        if (alts.length) row.append(h('span.tno', '('), ...alts.flatMap(a => mv(a, true)), h('span.tno', ')'));
        const cont = kids.filter(c => !c.alt);
        if (!cont.length) {
          if (x.tr != null) row.append(h('span.ttr', { onclick: () => goTo(x.tr), title: 'Même position ailleurs dans l\'arbre' }, '↪ transpose'));
          return;
        }
        if (cont.length === 1) { x = cont[0]; continue; }
        cont.forEach(c => {
          const open = expandAll || onTrail.has(c.id) || openSet.has(c.id);
          const br = h('div.tbranch');
          container.append(br);
          const toggle = h('span.ttoggle', { onclick: () => { open ? openSet.delete(c.id) : openSet.add(c.id); if (open && onTrail.has(c.id)) goTo(x.id); else drawTree(); } }, open ? '▾' : '▸');
          if (open) { const inner = h('div'); br.append(h('div.row', { style: { gap: '2px', flexWrap: 'nowrap', alignItems: 'baseline' } }, toggle, inner)); lineFrom(c, inner, true); }
          else {
            const ans = mainMove(c);
            br.append(h('div.tline', toggle, ...mv(c, true), ans ? mv(ans, false) : [], h('span.tno', next(ans || c).length ? '…' : '')));
          }
        });
        return;
      }
    }
    const rootKids = node(0).ch.map(node);
    if (rootKids.length === 1) lineFrom(rootKids[0], box, true);
    else rootKids.forEach(c => lineFrom(c, box, true));
    bottom.innerHTML = '';
    bottom.append(card);
    const curEl = box.querySelector('.tmv.cur');   // scroll the tree box only, never the page
    if (curEl && (curEl.offsetTop < box.scrollTop || curEl.offsetTop > box.scrollTop + box.clientHeight - 30))
      box.scrollTop = curEl.offsetTop - box.clientHeight / 3;
  }

  // ------------------------------------------------------------ training
  const prompt = h('div', { style: { fontSize: '17px', fontWeight: 700 } });
  const feedback = h('div');
  const actions = h('div.row', { style: { marginTop: '10px' } });
  const lineProg = h('div.lineprog');

  function drawTrain() {
    side.innerHTML = '';
    const s = reps.find(r => r.id === rid);
    const modes = h('div.chips');
    [['due', `À réviser (${s.due})`], ['new', `Nouvelles (${s.new})`], ['all', 'Toutes']].forEach(([k, l]) =>
      modes.append(h('div.chip' + (trainMode === k ? '.on' : ''), { onclick: () => { trainMode = k; store.set('rep.mode', k); drawTrain(); startLine(); } }, l)));    const branchNode = trail.length ? cur() : null;
    const branch = branchNode ? h('label.switch.small', { style: { marginTop: '10px' } },
      h('input', { type: 'checkbox', checked: trainBranch, onchange: e => { trainBranch = e.target.checked; startLine(); } }),
      `Seulement la branche ${pathText(trail)}`) : null;
    side.append(
      h('div.card', modes, branch,
        h('div.progress', { style: { margin: '12px 0 4px' } }, h('div', { style: { width: (s.cards ? 100 * s.learned / s.cards : 0) + '%' } })),
        h('div.small.muted', `${s.learned} positions maîtrisées (intervalle ≥ 21 j) sur ${s.cards} · ${s.new} jamais vues`)),
      h('div.card', prompt, feedback, lineProg, actions),
      h('div.card.small.muted', 'Les coups adverses sont joués automatiquement ; à toi de trouver le coup du répertoire. Chaque position est revue en répétition espacée : ratée, elle revient dans 10 minutes ; réussie, dans 1, 3, puis 7+ jours. ',
        h('kbd', 'H'), ' indice · ', h('kbd', 'Entrée'), ' ligne suivante.'));
  }

  function stopDrill() { drillToken++; drill = null; if (waiting) { waiting.cancel(); waiting = null; } }

  async function startLine() {
    stopDrill();
    const my = drillToken;
    feedback.innerHTML = ''; actions.innerHTML = ''; lineProg.innerHTML = '';
    const start = trainBranch && trail.length ? trail[trail.length - 1] : undefined;
    const line = await api.repLine(rid, { mode: trainMode, start });
    if (my !== drillToken) return;
    if (!line || !line.steps.length) { prompt.textContent = 'Rien à entraîner ici.'; return; }
    drill = { ...line, i: 0, ok: 0, ko: 0 };
    board.setOrientation(data.color);
    board.setFen(START_FEN); board.setLast(null); board.setArrows([]); board.setHint(null);
    board.opts.movable = data.color;
    crumbs.innerHTML = '';
    const why = { due: 'ligne avec des positions à réviser', new: 'ligne avec des positions nouvelles', all: 'ligne au hasard' }[line.mode];
    prompt.textContent = `Nouvelle ligne (${why})`;
    if (line.mode !== trainMode) feedback.append(h('div.feedback.info', trainMode === 'due' ? 'Rien à réviser pour l\'instant : on passe aux positions nouvelles.' : 'Plus de positions nouvelles : ligne au hasard.'));
    for (; drill && my === drillToken && drill.i < drill.steps.length; drill.i++) {
      const s = drill.steps[drill.i];
      if (!s.ours || s.auto) {
        await sleep(s.auto ? 150 : 500);
        if (my !== drillToken) return;
        board.play(s.uci);
        playSound('move', state.settings.sound);
        lineProg.append(h('span' + (s.ours ? '.mine' : ''), labelStep(s)));
        continue;
      }
      prompt.textContent = 'À toi : joue le coup du répertoire';
      const ok = await waitMove(s);
      if (ok === null || my !== drillToken) return;
    }
    if (my === drillToken && drill) finishLine();
  }

  const labelStep = s => { const n = node(s.id); return `${num(n, true)} ${n.san}`; };

  function waitMove(s) {
    return new Promise(resolve => {
      const w = { s, failed: false, resolve, cancel: () => resolve(null) };
      waiting = w;
    });
  }

  async function onDrillMove(m) {
    const w = waiting;
    if (!w || !drill) { board.setFen(board.fen); return; }
    const s = w.s;
    const n = node(s.id);
    if (m.uci === s.uci || (s.accept || []).includes(m.uci)) {
      const exact = m.uci === s.uci;
      if (!w.failed) { drill.ok++; api.repReview(rid, s.card, true).catch(() => {}); }
      waiting = null;
      const before = board.fen;
      board.play(m.uci);
      if (!exact) { await sleep(600); board.setFen(before); board.play(s.uci); }   // the line continues from the main move
      playSound('ok', state.settings.sound);
      feedback.innerHTML = '';
      feedback.append(h('div.feedback.ok', exact ? `✅ ${n.san}` : `✅ ${m.san} est accepté, mais le répertoire joue ${n.san}.`,
        n.c ? h('div.small', { style: { fontWeight: 400, marginTop: '4px' } }, n.c) : null));
      lineProg.append(h('span.mine.' + (w.failed ? 'ko' : 'ok'), labelStep(s)));
      board.setHint(null); board.setArrows([]);
      w.resolve(true);
      return;
    }
    // wrong move: show the answer, the position comes back and the user has to play it
    const fen = board.fen;
    board.play(m.uci);
    playSound('error', state.settings.sound);
    if (!w.failed) { w.failed = true; drill.ko++; api.repReview(rid, s.card, false).catch(() => {}); }
    feedback.innerHTML = '';
    feedback.append(h('div.feedback.ko', `❌ ${m.san} n'est pas le coup du répertoire. Joue ${n.san}.`,
      n.c ? h('div.small', { style: { fontWeight: 400, marginTop: '4px' } }, n.c) : null));
    setTimeout(() => {
      if (waiting !== w) return;
      board.setFen(fen);
      board.setArrows([{ from: s.uci.slice(0, 2), to: s.uci.slice(2, 4), color: '#7fa650' }]);
    }, 900);
  }

  function hint() {
    if (!waiting) return;
    const s = waiting.s;
    if (!waiting.failed) { waiting.failed = true; drill.ko++; api.repReview(rid, s.card, false).catch(() => {}); }
    board.setHint(s.uci.slice(0, 2));
  }

  async function finishLine() {
    const leaf = node(drill.leaf);
    const mine = drill.ok + drill.ko;
    prompt.textContent = drill.ko ? `Ligne terminée : ${drill.ok}/${mine} du premier coup` : `🎉 Ligne parfaite (${mine}/${mine})`;
    if (leaf.c) feedback.append(h('div.feedback.info', h('b', 'Plan : '), leaf.c));
    actions.innerHTML = '';
    actions.append(
      h('button.btn.primary', { onclick: () => startLine() }, 'Ligne suivante (Entrée)'),
      h('button.btn.sm', { onclick: () => { const id = drill.leaf; stopDrill(); tab = 'explore'; store.set('rep.tab', tab); drawChips(); goTo(id); draw(); } }, 'Voir dans l\'arbre'));
    drill.done = true;
    reps = await api.repertoires();
    drawChips();
    if (tab === 'train') drawTrain();   // refresh the counters (prompt/feedback nodes are kept)
  }

  // ------------------------------------------------------------ games tab
  function drawGames() {
    const r = data.report;
    const devs = r.deviations.filter(d => !d.alt);
    const tiles = h('div.grid.g4',
      tile(r.games, 'parties dans ce répertoire'), tile(r.avg_depth ?? '–', 'coups de préparation en moyenne'),
      tile(devs.length, 'écarts au répertoire'), tile(r.holes.length, 'coups adverses non préparés'));
    const devCard = h('div.card', h('h2', 'Tes écarts'),
      h('div.small.muted', { style: { marginBottom: '8px' } }, 'Les parties où tu as quitté le répertoire. La perte est celle mesurée par l\'analyse de la partie (probabilité de gain perdue).'));
    if (!r.deviations.length) devCard.append(h('div.muted', 'Aucun écart : bravo !'));
    r.deviations.slice(0, 30).forEach(d => {
      const lossTxt = d.loss != null ? `−${Math.round(d.loss * 10) / 10}%` : '';
      const sev = d.alt ? h('span.tag', { style: { color: 'var(--accent2)' } }, 'variante acceptée')
        : d.loss == null ? h('span.tag', 'non analysée') : d.loss >= 10 ? h('span.tag.bad', lossTxt) : d.loss >= 3 ? h('span.tag.warnc', lossTxt) : h('span.tag', 'sans gravité');
      const costly = !d.alt && d.loss != null && d.loss >= 3;
      devCard.append(h('div.moment', { onclick: () => { goTo(d.node); } },
        resultBadge(d.result),
        h('div', { style: { flex: 1 } }, h('div', `Coup ${Math.ceil(d.ply / 2)} : tu as joué `, h('b', { class: costly ? 'bad' : '' }, d.played), ' — répertoire : ', h('b.good', d.expected), ' ', sev),
          h('div.small.dim', `${fmtDate(d.played_at)} · ${TC[d.tc] || d.tc || ''} · contre ${d.opponent}`)),
        h('a.btn.sm', { href: `#/review/${d.game_id}?ply=${d.ply}`, onclick: e => e.stopPropagation() }, 'Partie')));
    });
    const holeCard = h('div.card', h('h2', 'Trous du répertoire'),
      h('div.small.muted', { style: { marginBottom: '8px' } }, 'Coups que tes adversaires ont joués et que le répertoire ne couvre pas encore. Clique pour voir la position et la réponse de Stockfish.'));
    if (!r.holes.length) holeCard.append(h('div.muted', 'Tout ce que tes adversaires ont joué est couvert.'));
    r.holes.slice(0, 20).forEach(x => {
      const n = node(x.node);
      const row = holeRow(n, x);
      row.prepend(h('span.small.dim', { style: { flex: 'none', maxWidth: '45%' } }, pathText(trailOf(n))));
      row.addEventListener('click', () => goTo(n.id));
      holeCard.append(row);
    });
    side.append(tiles, h('div', { style: { height: '14px' } }));
    side.append(holeCard);
    bottom.append(devCard);
  }
  const tile = (v, l) => h('div.card.tile', { style: { marginTop: 0 } }, h('div.val', v), h('div.sub', l));
  function trailOf(n) { const p = []; for (let x = n; x && x.p != null; x = node(x.p)) p.unshift(x.id); return p; }

  // ------------------------------------------------------------ keyboard
  const onKey = e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (tab === 'train') {
      if (e.key === 'Enter' && drill?.done) startLine();
      if (e.key === 'h') hint();
      return;
    }
    if (e.key === 'ArrowLeft') back();
    else if (e.key === 'ArrowRight') forward();
    else if (e.key === 'ArrowUp') goRoot();
    else if (e.key === 'f') board.flip();
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);

  await load();
  drawChips();
  draw();
  return () => { stopDrill(); clearTimeout(pollTimer); window.removeEventListener('keydown', onKey); };
}
