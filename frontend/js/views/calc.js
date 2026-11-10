import { Chess } from '../../vendor/chess.js';
import { api } from '../api.js';
import { Board } from '../board.js';
import { state } from '../state.js';
import { h, store, THEME_FR, playSound, toast, sleep } from '../util.js';

/** Notation française tolérée : C=Cavalier, F=Fou, T=Tour, D=Dame, R=Roi (si « R » anglais est illégal). */
function parseSan(chess, raw) {
  let t = raw.trim().replace(/[!?]+$/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O');
  if (!t) return null;
  const tries = [t];
  const map = { C: 'N', F: 'B', T: 'R', D: 'Q', R: 'K' };
  const fr = t.replace(/^[CFTDR]/, c => map[c]).replace(/=([CFTD])/, (_, c) => '=' + map[c]);
  if (fr !== t) tries.push(fr);
  if (/^R/.test(t)) tries.push(t);                 // « R » = tour en anglais
  for (const s of tries) {
    try { const m = chess.move(s); if (m) return m; } catch { /* essaie la suivante */ }
  }
  return null;
}

export async function render(root) {
  const st = await api.tacticsStats();
  const host = h('div');
  root.append(host);
  if (!st.available) {
    host.append(h('div.card.empty', h('h2', 'Base de tactiques non installée'), h('p', 'Voir la page Entraînement pour l\'installer.')));
    return;
  }
  let p = null, setupFen = null, mine = [], replies = [], tries = 0, hintsUsed = 0, t0 = 0, done = false, blind = store.get('calc.blind', false), theme = '';
  const token = { cancelled: false };
  const boardHost = h('div');
  const prompt = h('div', { style: { fontSize: '17px', fontWeight: 700 } });
  const meta = h('div.small.muted');
  const chips = h('div.linechips');
  const input = h('input.calc-input', { type: 'text', placeholder: 'Ex : Cxe5 Fxe5 Dh5+', autocomplete: 'off', spellcheck: 'false' });
  const feedback = h('div');
  const actions = h('div.row', { style: { marginTop: '10px' } });
  const side = h('div.card');
  const board = new Board(boardHost, { interactive: false, theme: state.settings.board_theme });

  host.append(h('div.page-head', h('div', h('h1', 'Calcul'),
    h('div.muted', 'Au-dessus de 1600, on gagne en calculant 4–6 coups sans toucher les pièces. Trouve toute la ligne, puis écris tes coups.'))),
    h('div.review', h('div.boardcol', boardHost),
      h('div', h('div.card', h('div.row', prompt), meta, chips,
        h('div', { style: { margin: '10px 0 6px' } }, input),
        h('div.small.dim', 'Écris UNIQUEMENT tes coups, séparés par des espaces (les réponses de l\'adversaire sont forcées). Notation française (C F T D R) ou anglaise.'),
        feedback, actions), h('div', { style: { height: '14px' } }), side)));

  function drawSide() {
    side.innerHTML = '';
    const sel = h('select', { onchange: e => { theme = e.target.value; load(); } }, h('option', { value: '' }, 'Tous les thèmes'));
    api.tacticsThemes().then(ts => { ts.forEach(t => sel.append(h('option', { value: t.theme, selected: theme === t.theme }, t.label))); });
    side.append(h('h3', 'Réglages'),
      h('label.row', h('input', { type: 'checkbox', checked: blind, onchange: e => { blind = e.target.checked; store.set('calc.blind', blind); if (p && !done) board.root.classList.toggle('blind', blind && started); } }), ' Mode aveugle : les pièces disparaissent quand tu commences à écrire'),
      h('div', { style: { marginTop: '8px' } }, sel),
      h('div.small.dim', { style: { marginTop: '8px' } }, 'Conseil : étudie la position 30–60 s, vérifie échecs/captures/menaces pour chaque camp, puis écris ta ligne complète.'));
  }

  let started = false;
  function setStarted(v) { started = v; board.root.classList.toggle('blind', blind && v); }

  async function load(exclude) {
    token.cancelled = true; await sleep(0); token.cancelled = false;
    feedback.innerHTML = ''; actions.innerHTML = ''; chips.innerHTML = ''; input.value = ''; input.disabled = true;
    setStarted(false); board.setArrows([]); board.setLast(null);
    p = await api.tacticsNext({ mode: 'calc', theme, exclude });
    done = false; tries = 0; hintsUsed = 0;
    if (!p) { board.setFen('8/8/8/8/8/8/8/8 w - - 0 1'); prompt.textContent = 'Aucun puzzle long pour cette sélection.'; return; }
    const c = new Chess(p.fen);
    c.move({ from: p.moves[0].slice(0, 2), to: p.moves[0].slice(2, 4), promotion: p.moves[0][4] });
    setupFen = c.fen();
    const sideToMove = c.turn();
    mine = p.moves.filter((_, i) => i % 2 === 1);
    replies = p.moves.filter((_, i) => i % 2 === 0 && i > 0);
    board.setOrientation(sideToMove);
    board.setFen(p.fen);
    prompt.textContent = 'L\'adversaire joue…';
    meta.textContent = `Difficulté ≈ ${p.rating}`;
    await sleep(550);
    if (token.cancelled) return;
    board.play(p.moves[0]);
    prompt.textContent = `${sideToMove === 'w' ? 'Les Blancs' : 'Les Noirs'} jouent — trouve une ligne de ${mine.length} coups`;
    meta.textContent = `Difficulté ≈ ${p.rating} · ${mine.length} coups à écrire`;
    input.disabled = false; input.focus();
    t0 = Date.now();
    actions.append(h('button.btn.primary', { onclick: validate }, 'Valider ma ligne (Entrée)'),
      h('button.btn.sm', { onclick: hint }, '💡 Indice'),
      h('button.btn.sm', { onclick: () => reveal('failed') }, 'Voir la solution'),
      h('button.btn.sm', { onclick: () => load(p.id) }, 'Passer →'));
  }

  function hint() {
    if (done || !p) return;
    hintsUsed++;
    const sol = new Chess(setupFen).move({ from: mine[0].slice(0, 2), to: mine[0].slice(2, 4), promotion: mine[0][4] });
    feedback.replaceChildren(h('div.feedback.info', hintsUsed === 1 ? '💡 ' + (p.themes.filter(t => THEME_FR[t]).map(t => THEME_FR[t]).slice(0, 2).join(', ') || 'Cherche échecs, captures, menaces.')
      : `💡 Le premier coup est : ${sol.san}`));
  }

  function evalLine(text) {
    const toks = text.split(/[\s,]+/).filter(Boolean).filter(t => !/^\d+\.+$/.test(t)).map(t => t.replace(/^\d+\.+/, ''));
    const c = new Chess(setupFen);
    const res = [];
    for (let i = 0; i < toks.length && i < mine.length; i++) {
      const m = parseSan(c, toks[i]);
      if (!m) { res.push({ t: toks[i], st: 'illegal' }); break; }
      const uci = m.from + m.to + (m.promotion || '');
      const ok = uci === mine[i] || c.isCheckmate();
      res.push({ t: m.san, st: ok ? 'ok' : 'ko' });
      if (!ok) break;
      if (c.isCheckmate()) break;
      if (replies[i]) c.move({ from: replies[i].slice(0, 2), to: replies[i].slice(2, 4), promotion: replies[i][4] });
    }
    return { toks, res };
  }

  async function validate() {
    if (done || !p) return;
    const text = input.value.trim();
    if (!text) return;
    setStarted(true);
    const { toks, res } = evalLine(text);
    chips.innerHTML = '';
    res.forEach(r => chips.append(h('span.' + (r.st === 'ok' ? 'ok' : 'ko'), r.t + (r.st === 'illegal' ? ' (illégal)' : ''))));
    const good = res.filter(r => r.st === 'ok').length;
    if (res.length && res.every(r => r.st === 'ok') && (good >= mine.length || endedWithMate(res))) {
      await reveal(tries === 0 && hintsUsed === 0 ? 'clean' : 'assisted');
      return;
    }
    if (toks.length < mine.length && res.every(r => r.st === 'ok')) {
      feedback.replaceChildren(h('div.feedback.info', `Il faut ${mine.length} coups : tu en as écrit ${toks.length}. Continue ta ligne.`));
      return;
    }
    tries++;
    playSound('error', state.settings.sound);
    feedback.replaceChildren(h('div.feedback.ko', good ? `❌ Les ${good} premier(s) coup(s) sont bons, mais le suivant n'est pas le bon.` : '❌ Le premier coup n\'est pas le bon.',
      h('div', { style: small }, 'Réfléchis encore (le plateau reste caché en mode aveugle) ou demande un indice.')));
    if (tries >= 3 && hintsUsed === 0) hint();
  }
  const small = { fontWeight: 400, marginTop: '4px' };

  function endedWithMate(res) {
    const c = new Chess(setupFen);
    for (let i = 0; i < res.length; i++) {
      const m = parseSan(c, res[i].t); if (!m) return false;
      if (c.isCheckmate()) return true;
      if (replies[i]) c.move({ from: replies[i].slice(0, 2), to: replies[i].slice(2, 4), promotion: replies[i][4] });
    }
    return false;
  }

  async function reveal(outcome) {
    done = true; input.disabled = true;
    setStarted(false);
    let r = null;
    try { r = await api.tacticsResult(p.id, outcome, Date.now() - t0, hintsUsed, 'calc'); api.dailyLog('calc'); } catch (e) { toast(e.message, 'err'); }
    playSound(outcome === 'failed' ? 'error' : 'ok', state.settings.sound);
    const c = new Chess(setupFen), sans = [];
    p.moves.slice(1).forEach(u => { const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); sans.push(m.san); });
    feedback.replaceChildren(h('div.feedback.' + (outcome === 'failed' ? 'ko' : 'ok'),
      outcome === 'clean' ? '✅ Ligne exacte du premier coup !' : outcome === 'assisted' ? '✅ Trouvé (avec essais/indices : moins de points).' : 'Voici la ligne :',
      h('div', { style: small }, sans.join(' ')),
      r ? h('div', { style: small }, `Classement ${r.rating} (${r.delta >= 0 ? '+' : ''}${r.delta})`) : null));
    actions.replaceChildren(h('button.btn.primary', { onclick: () => load(p.id) }, 'Suivant'));
    board.setFen(setupFen);
    for (const u of p.moves.slice(1)) { await sleep(700); if (token.cancelled) return; board.play(u); }
  }

  input.addEventListener('keydown', e => { if (e.key === 'Enter') validate(); });
  input.addEventListener('input', () => { if (input.value && !started && p && !done) setStarted(true); });
  drawSide();
  await load();
  return () => { token.cancelled = true; };
}
