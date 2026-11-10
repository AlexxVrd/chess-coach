import { Chess } from '../../vendor/chess.js';
import { api } from '../api.js';
import { Board } from '../board.js';
import { state } from '../state.js';
import { h, store, PHASES, THEME_FR, TAGS, hintText, playSound, toast, sleep } from '../util.js';

const X_BADGE = { sym: '✗', color: '#ca3431' };
const OK_BADGE = { sym: '✓', color: '#7fa650' };
const small = { fontWeight: 400, marginTop: '4px' };

/** Show a wrong move briefly, then put the position back. Never leaves the board in a dead state. */
async function flashWrong(board, uci, backFen) {
  board.play(uci);
  board.setBadge(uci.slice(2, 4), X_BADGE);
  await sleep(800);
  board.setBadge(null);
  board.setFen(backFen);
  board.setLast(null);
}

/** Play a line of UCI moves from a position, one by one. */
async function playLine(board, startFen, pv, delay = 800, token) {
  board.setFen(startFen); board.setArrows([]); board.setBadge(null);
  for (const u of pv) {
    await sleep(delay);
    if (token && token.cancelled) return;
    board.play(u);
  }
}

export async function render(root, params) {
  let tab = params.tab || store.get('tr.tab', 'mistakes');
  const cleanups = [];
  const host = h('div');
  root.append(host);

  function mount(newTab) {
    cleanups.splice(0).forEach(f => f());
    tab = newTab; store.set('tr.tab', tab);
    host.innerHTML = '';
    const tabs = h('div.tabs', { style: { maxWidth: '420px' } },
      h('div.tab' + (tab === 'tactics' ? '.on' : ''), { onclick: () => mount('tactics') }, '⚡ Tactiques classées'),
      h('div.tab' + (tab === 'mistakes' ? '.on' : ''), { onclick: () => mount('mistakes') }, '🧩 Mes erreurs'));
    host.append(h('div.page-head', h('div', h('h1', 'Entraînement'), h('div.muted', 'Les tactiques font gagner des points : volume + régularité. Mes erreurs, elles, ne reviendront plus.'))), tabs);
    const body = h('div');
    host.append(body);
    (tab === 'tactics' ? tacticsTab : mistakesTab)(body, cleanups);
  }

  // =============================================================================================
  //  TACTICS (lichess puzzle database, client-side validation = instant feedback)
  // =============================================================================================
  async function tacticsTab(body, cl) {
    const st = await api.tacticsStats();
    if (!st.available) {
      body.append(h('div.card.empty', h('h2', 'Base de tactiques non installée'),
        h('p', 'Lance une fois dans le terminal :'), h('pre', '.venv/bin/python -I tools/import_lichess_puzzles.py <fichier .csv.zst> data/lichess_puzzles.db')));
      return;
    }
    let mode = store.get('tac.mode', 'rated'), theme = store.get('tac.theme', '');
    let p = null, idx = 0, mistakes = 0, hints = 0, t0 = 0, busy = false, done = false, session = { n: 0, clean: 0, streak: 0 }, hintLevel = 0, side = 'w';
    const token = { cancelled: false };
    cl.push(() => { token.cancelled = true; clearInterval(timer); window.removeEventListener('keydown', onKey); });

    const boardHost = h('div');
    const prompt = h('div', { style: { fontSize: '17px', fontWeight: 700 } });
    const meta = h('div.small.muted');
    const feedback = h('div');
    const actions = h('div.row', { style: { marginTop: '10px' } });
    const clock = h('span.mono.muted');
    const ratingBox = h('div.card');
    const themeBox = h('div.card');
    const modeBox = h('div.card');
    body.append(h('div.review', h('div.boardcol', boardHost),
      h('div', h('div.card', h('div.row', prompt, h('span.right', clock)), meta, feedback, actions), h('div', { style: { height: '14px' } }), modeBox, h('div', { style: { height: '14px' } }), ratingBox, h('div', { style: { height: '14px' } }), themeBox)));
    const board = new Board(boardHost, { interactive: true, theme: state.settings.board_theme, onMove: m => onMove(m) });
    let timer = setInterval(() => { if (p && !done) clock.textContent = fmt((Date.now() - t0) / 1000); }, 500);
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    async function drawSide(fresh) {
      const s = fresh ? await api.tacticsStats() : st;
      Object.assign(st, s);
      ratingBox.innerHTML = '';
      ratingBox.append(h('div.row', h('div', h('div.small.muted', 'MON CLASSEMENT TACTIQUE'), h('div', { style: { fontSize: '34px', fontWeight: 800 } }, st.rating)),
        h('div.right', { style: { textAlign: 'right' } }, h('div.small.muted', 'aujourd\'hui'), h('b', `${st.today} puzzles`), h('div.small.dim', `${st.week_pct ?? '–'}% réussis du 1er coup (7 j)`))),
        h('div.small.dim', { style: { marginTop: '6px' } }, `Série en cours : ${session.streak} · ${st.total} puzzles résolus au total`));
      if (st.history.length > 4 && window.Chart) {
        const cv = h('canvas'); const box = h('div', { style: { height: '90px', marginTop: '8px' } }, cv); ratingBox.append(box);
        new window.Chart(cv, { type: 'line', data: { labels: st.history.map((_, i) => i), datasets: [{ data: st.history.map(x => x[1]), borderColor: '#f7c631', pointRadius: 0, borderWidth: 2, tension: .3 }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } }, scales: { x: { display: false }, y: { ticks: { maxTicksLimit: 3 } } }, animation: false } });
      }
      themeBox.innerHTML = '';
      themeBox.append(h('h3', 'Mes schémas tactiques (réussite au 1er coup)'));
      if (!st.themes.length) themeBox.append(h('div.small.muted', 'Résous quelques puzzles pour voir tes points faibles par thème.'));
      st.themes.slice(0, 8).forEach(t => themeBox.append(h('div', { style: { margin: '6px 0', cursor: 'pointer' }, onclick: () => { mode = 'theme'; theme = t.theme; store.set('tac.mode', mode); store.set('tac.theme', theme); drawMode(); load(); } },
        h('div.row.small', h('span', t.label), h('span.right.muted', `${t.pct}% · ${t.n}`)), h('div.bar', h('i', { style: { width: t.pct + '%', background: t.pct < 50 ? '#ca3431' : t.pct < 70 ? '#e58f2a' : '#7fa650' } })))));
      if (st.themes.length) themeBox.append(h('div.small.dim', { style: { marginTop: '6px' } }, 'Clique un thème pour t\'entraîner dessus.'));
    }
    async function drawMode() {
      const themes = await api.tacticsThemes();
      modeBox.innerHTML = '';
      const chips = h('div.chips');
      [['rated', 'À mon niveau'], ['hard', 'Plus dur (+120)'], ['review', `Révision (${st.due})`], ['theme', 'Par thème']].forEach(([k, l]) =>
        chips.append(h('div.chip' + (mode === k ? '.on' : ''), { onclick: () => { mode = k; store.set('tac.mode', k); drawMode(); load(); } }, l)));
      modeBox.append(chips);
      if (mode === 'theme') {
        const sel = h('select', { style: { marginTop: '10px' }, onchange: e => { theme = e.target.value; store.set('tac.theme', theme); load(); } },
          h('option', { value: '' }, 'Choisis un thème…'), themes.map(t => h('option', { value: t.theme, selected: theme === t.theme }, t.label)));
        modeBox.append(sel);
      }
    }

    async function load(exclude) {
      feedback.innerHTML = ''; actions.innerHTML = ''; meta.textContent = ''; clock.textContent = '';
      board.setArrows([]); board.setBadge(null); board.setHint(null); board.setLast(null);
      token.cancelled = true; await sleep(0); token.cancelled = false;
      p = await api.tacticsNext({ mode: mode === 'theme' && !theme ? 'rated' : mode, theme: mode === 'theme' ? theme : '', exclude });
      done = false; idx = 0; mistakes = 0; hints = 0; hintLevel = 0; busy = true;
      if (!p) {
        board.setFen('8/8/8/8/8/8/8/8 w - - 0 1');
        prompt.textContent = mode === 'review' ? 'Rien à réviser pour le moment 🎉' : 'Plus de puzzle disponible pour cette sélection.';
        busy = false;
        return;
      }
      const c = new Chess(p.fen);
      c.move({ from: p.moves[0].slice(0, 2), to: p.moves[0].slice(2, 4), promotion: p.moves[0][4] });
      side = c.turn();
      board.setOrientation(side); board.opts.movable = side;
      board.setFen(p.fen);
      prompt.textContent = 'L\'adversaire joue…';
      meta.textContent = `Difficulté ≈ ${p.rating}` + (p.review ? ' · révision' : '');
      await sleep(550);
      if (token.cancelled) return;
      board.play(p.moves[0]); idx = 1;
      prompt.textContent = `${side === 'w' ? 'Les Blancs' : 'Les Noirs'} jouent — trouve le meilleur coup`;
      actions.append(hintBtn(), h('button.btn.sm', { onclick: solution }, 'Voir la solution'), h('button.btn.sm', { onclick: () => load(p.id) }, 'Passer →'));
      t0 = Date.now(); busy = false;
    }

    function hintBtn() {
      return h('button.btn.sm#hintbtn', { onclick: hint }, '💡 Indice');
    }
    function hint() {
      if (done || !p) return;
      hintLevel = Math.min(3, hintLevel + 1); hints++;
      const exp = p.moves[idx];
      if (hintLevel === 1) feedback.replaceChildren(h('div.feedback.info', '💡 ' + hintText(p.themes)));
      if (hintLevel === 2) { board.setHint(exp.slice(0, 2)); feedback.replaceChildren(h('div.feedback.info', '💡 Déplace la pièce en surbrillance.')); }
      if (hintLevel === 3) { board.setArrows([{ from: exp.slice(0, 2), to: exp.slice(2, 4), color: '#5c8bb0' }]); feedback.replaceChildren(h('div.feedback.info', '💡 Voilà le coup. Joue-le pour continuer.')); }
    }

    async function onMove(m) {
      if (!p || busy || done) { board.setFen(board.fen); return; }
      busy = true;
      const exp = p.moves[idx];
      const before = board.fen;
      let ok = m.uci === exp;
      if (!ok) { const c = new Chess(before); c.move({ from: m.from, to: m.to, promotion: m.promotion }); ok = c.isCheckmate(); }
      if (!ok) {
        mistakes++;
        playSound('error', state.settings.sound);
        feedback.replaceChildren(h('div.feedback.ko', `❌ ${m.san} n'est pas le bon coup. Réessaie !`));
        await flashWrong(board, m.uci, before);
        if (mistakes === 2 && hintLevel === 0) hint();
        busy = false;
        return;
      }
      board.play(m.uci); board.setArrows([]); board.setHint(null);
      playSound(m.captured ? 'capture' : 'move', state.settings.sound);
      idx++;
      const mated = board.chess.isCheckmate();
      if (idx >= p.moves.length || mated) { await success(); return; }
      feedback.replaceChildren(h('div.feedback.ok', '✓ Bien joué — continue…'));
      await sleep(450);
      board.play(p.moves[idx]); idx++;
      playSound('move', state.settings.sound);
      if (idx >= p.moves.length) { await success(); return; }
      feedback.innerHTML = ''; hintLevel = 0; busy = false;
    }

    async function success() {
      done = true;
      const outcome = mistakes === 0 && hints === 0 ? 'clean' : 'assisted';
      session.n++; if (outcome === 'clean') { session.clean++; session.streak++; } else session.streak = 0;
      playSound('ok', state.settings.sound);
      let r = null;
      try { r = await api.tacticsResult(p.id, outcome, Date.now() - t0, hints, p.review ? 'review' : mode); } catch (e) { toast(e.message, 'err'); }
      feedback.replaceChildren(h('div.feedback.ok', outcome === 'clean' ? '✅ Résolu du premier coup !' : '✅ Résolu (avec aide / après erreur : moins de points).',
        r ? h('div', { style: small }, `Classement ${r.rating} (${r.delta >= 0 ? '+' : ''}${r.delta})`) : null,
        p.themes.length ? h('div.taglist', { style: { marginTop: '8px' } }, p.themes.filter(t => THEME_FR[t]).map(t => h('span.tag', THEME_FR[t]))) : null));
      actions.replaceChildren(h('button.btn.primary', { onclick: () => load(p.id) }, 'Suivant (Entrée)'));
      drawSide(true);
    }

    async function solution() {
      if (done || !p) return;
      done = true; busy = true;
      let r = null;
      try { r = await api.tacticsResult(p.id, 'failed', Date.now() - t0, hints, p.review ? 'review' : mode); } catch (e) { /* ignore */ }
      session.streak = 0;
      feedback.replaceChildren(h('div.feedback.info', 'Voici la solution. Observe bien le schéma : ce puzzle reviendra demain.', r ? h('div', { style: small }, `Classement ${r.rating} (${r.delta})`) : null));
      actions.replaceChildren(h('button.btn.primary', { onclick: () => load(p.id) }, 'Suivant (Entrée)'));
      await playLine(board, board.fen, p.moves.slice(idx), 850, token);
      busy = false;
      drawSide(true);
    }

    const onKey = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'Enter' && done) load(p && p.id);
      if (e.key === 'h') hint();
    };
    window.addEventListener('keydown', onKey);
    await drawSide(false);
    await drawMode();
    if (mode === 'review' && !st.due) { mode = 'rated'; drawMode(); }
    await load();
  }

  // =============================================================================================
  //  MY MISTAKES (positions from my own games, verified by the engine, spaced repetition)
  // =============================================================================================
  async function mistakesTab(body, cl) {
    const f = { mode: store.get('tr.mode', 'due'), tag: store.get('tr.tag', ''), phase: store.get('tr.phase', ''), theme: store.get('tr.theme', '') };
    let puzzle = null, fen = '', step = 0, mistakes = 0, hints = 0, hintLevel = 0, t0 = 0, busy = false, done = false;
    const token = { cancelled: false };
    const boardHost = h('div');
    const prompt = h('div', { style: { fontSize: '17px', fontWeight: 700 } });
    const ctx = h('div.small.muted');
    const feedback = h('div');
    const actions = h('div.row', { style: { marginTop: '10px' } });
    const statsCard = h('div.card');
    const filterCard = h('div.card');
    body.append(h('div.review', h('div.boardcol', boardHost),
      h('div', h('div.card', prompt, ctx, feedback, actions), h('div', { style: { height: '14px' } }), filterCard, h('div', { style: { height: '14px' } }), statsCard)));
    const board = new Board(boardHost, { interactive: true, theme: state.settings.board_theme, onMove: m => onMove(m) });
    cl.push(() => { token.cancelled = true; window.removeEventListener('keydown', onKey); });

    const stat = (v, l) => h('div', { style: { textAlign: 'center' } }, h('div', { style: { fontSize: '24px', fontWeight: 800 } }, v), h('div.small.muted', l));
    async function loadStats() {
      const s = await api.puzzleStats();
      filterCard.innerHTML = '';
      const chips = h('div.chips');
      [['due', `À réviser (${s.due})`], ['new', `Nouveaux (${s.new})`], ['failed', 'Mes ratés'], ['all', `Tous (${s.total})`]].forEach(([k, l]) =>
        chips.append(h('div.chip' + (f.mode === k ? '.on' : ''), { onclick: () => { f.mode = k; store.set('tr.mode', k); loadStats(); next(); } }, l)));
      const themeSel = h('select', { onchange: e => { f.theme = e.target.value; store.set('tr.theme', f.theme); next(); } },
        h('option', { value: '' }, 'Tous les thèmes'), Object.entries(s.theme_stats || {}).map(([t, v]) => h('option', { value: t, selected: f.theme === t }, `${THEME_FR[t] || t} (${v.n})`)));
      const tagSel = h('select', { onchange: e => { f.tag = e.target.value; store.set('tr.tag', f.tag); next(); } },
        h('option', { value: '' }, 'Tous les motifs d\'erreur'), Object.entries(s.by_tag).map(([t, v]) => h('option', { value: t, selected: f.tag === t }, `${TAGS[t] || t} (${v.n})`)));
      const phSel = h('select', { onchange: e => { f.phase = e.target.value; store.set('tr.phase', f.phase); next(); } },
        h('option', { value: '' }, 'Toutes phases'), Object.entries(PHASES).map(([k, l]) => h('option', { value: k, selected: f.phase === k }, l)));
      filterCard.append(chips, h('div.row', { style: { marginTop: '10px' } }, themeSel, tagSel, phSel));
      statsCard.innerHTML = '';
      statsCard.append(h('h2', 'Ta progression'),
        h('div.grid.g3', stat(s.today, 'aujourd\'hui'), stat(s.streak + ' 🔥', 'jours de suite'), stat(s.week_success !== null ? s.week_success + '%' : '–', 'réussite 7 j')),
        h('div.progress', { style: { margin: '14px 0 4px' } }, h('div', { style: { width: (s.total ? 100 * s.learned / s.total : 0) + '%' } })),
        h('div.small.muted', `${s.learned} puzzles maîtrisés (intervalle ≥ 21 jours) sur ${s.total}`));
      return s;
    }

    async function next(exclude) {
      token.cancelled = true; await sleep(0); token.cancelled = false;
      feedback.innerHTML = ''; actions.innerHTML = ''; ctx.textContent = '';
      board.setArrows([]); board.setBadge(null); board.setHint(null); board.setLast(null);
      puzzle = await api.puzzleNext({ mode: f.mode, tag: f.tag, phase: f.phase, theme: f.theme, exclude });
      done = false; mistakes = 0; hints = 0; hintLevel = 0; step = 0; busy = false;
      if (!puzzle) {
        board.setFen('8/8/8/8/8/8/8/8 w - - 0 1');
        prompt.textContent = f.mode === 'due' ? 'Rien à réviser pour le moment 🎉' : 'Aucun puzzle dans cette sélection.';
        feedback.append(h('div.feedback.info', f.mode === 'due' ? 'Passe sur « Nouveaux », ou fais des tactiques classées.' : 'Analyse plus de parties : chaque erreur claire devient un puzzle.'),
          h('div.row', h('button.btn.primary', { onclick: () => mount('tactics') }, '⚡ Tactiques classées'), h('a.btn', { href: '#/games' }, 'Parties')));
        return;
      }
      fen = puzzle.fen;
      board.setOrientation(puzzle.side); board.opts.movable = puzzle.side;
      board.setFen(fen);
      prompt.textContent = `${puzzle.side === 'w' ? 'Les Blancs' : 'Les Noirs'} jouent — trouve le meilleur coup`;
      const th = (puzzle.themes || []).filter(t => THEME_FR[t]).map(t => THEME_FR[t]);
      ctx.textContent = `${PHASES[puzzle.phase] || ''} · tu avais perdu ${puzzle.loss}% de chances ici` + (puzzle.reps ? ` · réussi ${puzzle.reps}×` : puzzle.lapses ? ` · raté ${puzzle.lapses}×` : ' · nouveau');
      t0 = Date.now();
      actions.append(h('button.btn.sm', { onclick: hint }, '💡 Indice'), h('button.btn.sm', { onclick: giveUp }, 'Voir la solution'), h('button.btn.sm', { onclick: () => next(puzzle.id) }, 'Passer →'));
    }

    async function bestHere() {
      if (step === 0 && puzzle.solution_uci) return puzzle.solution_uci;
      return (await api.bestMove(fen)).uci;
    }
    async function hint() {
      if (!puzzle || done) return;
      hintLevel = Math.min(3, hintLevel + 1); hints++;
      if (hintLevel === 1) { feedback.replaceChildren(h('div.feedback.info', '💡 ' + hintText(puzzle.themes, puzzle.mate_in))); return; }
      const u = await bestHere();
      if (hintLevel === 2) { board.setHint(u.slice(0, 2)); feedback.replaceChildren(h('div.feedback.info', '💡 Déplace la pièce en surbrillance.')); }
      else { board.setArrows([{ from: u.slice(0, 2), to: u.slice(2, 4), color: '#5c8bb0' }]); feedback.replaceChildren(h('div.feedback.info', '💡 Voilà le coup à jouer.')); }
    }

    async function onMove(m) {
      if (!puzzle || busy || done) { board.setFen(fen); return; }
      busy = true;
      board.play(m.uci);
      board.setHint(null); board.setArrows([]);
      feedback.replaceChildren(h('div.feedback.info', h('span.spinner', { style: { display: 'inline-block', marginRight: '8px' } }), 'Vérification par Stockfish…'));
      let r;
      try { r = await api.puzzleStep(puzzle.id, fen, m.uci, step); }
      catch (e) { toast(e.message, 'err'); board.setFen(fen); busy = false; feedback.innerHTML = ''; return; }
      if (r.correct) {
        playSound(m.captured ? 'capture' : 'ok', state.settings.sound);
        board.setBadge(m.to, OK_BADGE);
        if (r.done) { await finish(r); return; }
        feedback.replaceChildren(h('div.feedback.ok', `✓ ${r.eval.san} — continue : ${r.reply_san} est joué, trouve la suite.`));
        await sleep(700);
        board.setBadge(null);
        board.play(r.reply);
        fen = r.fen_after_reply; step++; hintLevel = 0;
        prompt.textContent = 'La combinaison continue — trouve la suite';
        busy = false;
      } else {
        mistakes++;
        playSound('error', state.settings.sound);
        const e = r.eval;
        feedback.replaceChildren(h('div.feedback.ko', `❌ ${e.san} ne convient pas (−${e.loss}% de chances).`,
          e.refutation ? h('div.small', { style: small }, 'Ce que ça permet : ', e.refutation) : null,
          h('div.small', { style: small }, mistakes >= 2 ? 'Utilise « Indice » : tu n\'es pas obligé de tout trouver seul.' : 'Réessaie — le plateau est remis en place.')));
        board.setBadge(m.to, X_BADGE);
        await sleep(900);
        board.setBadge(null); board.setFen(fen); board.setLast(null);
        if (mistakes === 2 && hintLevel === 0) hint();
        busy = false;
      }
    }

    async function finish(r) {
      done = true;
      const outcome = mistakes === 0 && hints === 0 ? 'clean' : 'assisted';
      let srs = null;
      try { srs = await api.puzzleFinish(puzzle.id, outcome, Date.now() - t0, hints); } catch (e) { toast(e.message, 'err'); }
      await sleep(300); board.setBadge(null);
      const th = (puzzle.themes || []).filter(t => THEME_FR[t]);
      feedback.replaceChildren(h('div.feedback.ok', outcome === 'clean' ? (r.exact ? '✅ Exact : c\'est le meilleur coup !' : '✅ Très bien : un coup presque aussi fort que celui du moteur.') : '✅ Résolu — il reviendra bientôt pour que tu le trouves seul.',
        puzzle.pv_san ? h('div.small', { style: small }, 'Ligne du moteur : ', puzzle.pv_san) : null,
        puzzle.played_san ? h('div.small', { style: small }, `Dans ta partie tu avais joué ${puzzle.played_san}` + (puzzle.refut_san ? ` → ${puzzle.refut_san}` : '') + '.') : null,
        srs && outcome === 'clean' ? h('div.small', { style: small }, `Prochaine révision dans ${srs.next_due_days} jour(s).`) : null,
        th.length ? h('div.taglist', { style: { marginTop: '8px' } }, th.map(t => h('span.tag', THEME_FR[t]))) : null));
      actions.replaceChildren(h('button.btn.primary', { onclick: () => { loadStats(); next(); } }, 'Suivant (Entrée)'), h('a.btn.sm', { href: `#/review/${puzzle.game_id}?ply=${puzzle.ply}` }, 'Voir dans la partie'));
      loadStats();
    }

    async function giveUp() {
      if (!puzzle || done) return;
      done = true; busy = true;
      try { await api.puzzleFinish(puzzle.id, 'failed', Date.now() - t0, hints); } catch (e) { /* ignore */ }
      feedback.replaceChildren(h('div.feedback.info', `Solution : ${puzzle.solution_san}`,
        puzzle.pv_san ? h('div.small', { style: small }, 'Ligne : ', puzzle.pv_san) : null,
        h('div.small', { style: small }, 'Il reviendra dans quelques minutes : retrouve-le seul.')));
      actions.replaceChildren(h('button.btn.primary', { onclick: () => { loadStats(); next(); } }, 'Suivant (Entrée)'),
        h('button.btn.sm', { onclick: () => playLine(board, puzzle.fen, puzzle.solution_pv.length ? puzzle.solution_pv : [puzzle.solution_uci], 800, token) }, '▶ Rejouer la ligne'));
      await playLine(board, fen, step === 0 ? (puzzle.solution_pv.length ? puzzle.solution_pv : [puzzle.solution_uci]) : [await bestHere()], 800, token);
      busy = false;
      loadStats();
    }

    const onKey = e => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'Enter' && done) { loadStats(); next(); }
      if (e.key === 'h') hint();
    };
    window.addEventListener('keydown', onKey);
    const s = await loadStats();
    if (f.mode === 'due' && s.due === 0) { f.mode = 'new'; await loadStats(); }
    await next();
  }

  mount(tab);
  return () => cleanups.splice(0).forEach(f => f());
}
