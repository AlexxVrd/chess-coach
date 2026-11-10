import { api } from '../api.js';
import { h, store, TAGS, PHASES, TC, fmtDate } from '../util.js';

let charts = [];

function chart(canvasParent, cfg, height = 240) {
  const box = h('div.chartbox', { style: { height: height + 'px' } });
  const cv = h('canvas');
  box.append(cv);
  canvasParent.append(box);
  const C = window.Chart;
  C.defaults.color = '#a8a59e';
  C.defaults.borderColor = '#34322e';
  C.defaults.font.family = '-apple-system, BlinkMacSystemFont, Inter, sans-serif';
  const c = new C(cv, { ...cfg, options: { responsive: true, maintainAspectRatio: false, ...cfg.options } });
  charts.push(c);
  return c;
}

function tile(label, val, sub, cls = '') {
  return h('div.card.tile', h('div.label', label), h('div.val' + (cls ? '.' + cls : ''), val), h('div.sub', sub || ''));
}

function wdlBar(r) {
  if (!r || !r.games) return h('div.dim', 'Aucune partie');
  const p = k => (100 * r[k] / r.games).toFixed(1) + '%';
  return h('div', h('div.wdl', h('i.w', { style: { width: p('win') } }), h('i.d', { style: { width: p('draw') } }), h('i.l', { style: { width: p('loss') } })),
    h('div.small.muted', { style: { marginTop: '4px' } }, `${r.games} parties · ${r.win}V ${r.draw}N ${r.loss}D · score ${r.score}%`));
}

function movingAvg(arr, n) {
  return arr.map((_, i) => { const s = arr.slice(Math.max(0, i - n + 1), i + 1); return s.reduce((a, b) => a + b, 0) / s.length; });
}

export async function render(root) {
  charts = [];
  const f = { tc: store.get('dash.tc', 'all'), days: store.get('dash.days', '') };
  const wrap = h('div');
  root.append(wrap);

  async function draw() {
    charts.forEach(c => c.destroy()); charts = [];
    wrap.innerHTML = '';
    const ov = await api.overview({ tc: f.tc, days: f.days });
    const T = ov.totals, A = ov.analysis || {};

    const tcChips = h('div.chips', ['all', 'rapid', 'blitz', 'bullet', 'classical', 'daily'].map(k =>
      h('div.chip' + (f.tc === k ? '.on' : ''), { onclick: () => { f.tc = k; store.set('dash.tc', k); draw(); } }, k === 'all' ? 'Toutes cadences' : TC[k])));
    const dayChips = h('div.chips', [['30', '30 j'], ['90', '3 mois'], ['365', '1 an'], ['', 'Tout']].map(([k, l]) =>
      h('div.chip' + (String(f.days) === k ? '.on' : ''), { onclick: () => { f.days = k; store.set('dash.days', k); draw(); } }, l)));
    wrap.append(h('div.page-head', h('div', h('h1', 'Tableau de bord'), h('div.muted', 'Ta progression, tes points faibles, ton plan.')), h('div.right.row', tcChips, dayChips)));

    // ---- daily session + goal tracker
    try { wrap.append(await todayCard()); } catch (e) { console.error(e); }

    if (!T.all.games) {
      wrap.append(h('div.card.empty', h('h2', 'Bienvenue 👋'),
        h('p', 'Aucune partie pour ces filtres. Commence par renseigner ton pseudo chess.com / lichess puis importe tes parties.'),
        h('a.btn.primary', { href: '#/settings' }, 'Configurer et importer')));
      return;
    }

    // ---- tiles
    const tcKey = f.tc !== 'all' ? f.tc : Object.keys(ov.rating_now).sort((a, b) => (ov.ratings[b]?.length || 0) - (ov.ratings[a]?.length || 0))[0];
    const now = ov.rating_now[tcKey], peak = ov.rating_peak[tcKey];
    const first = ov.ratings[tcKey]?.[0]?.[1];
    const delta = now && first ? now - first : null;
    const bpg = A.blunders_per_game;
    wrap.append(h('div.grid.g4',
      tile(`Classement ${TC[tcKey] || ''}`, now || '–', peak ? `max ${peak}` + (delta !== null ? ` · ${delta >= 0 ? '+' : ''}${delta} sur la période` : '') : ''),
      tile('Score', T.all.score + '%', `${T.all.games} parties · ${T.all.win}V ${T.all.draw}N ${T.all.loss}D`, T.all.score >= 52 ? 'good' : T.all.score < 45 ? 'bad' : ''),
      tile('Précision moyenne', A.avg_accuracy ? A.avg_accuracy + '%' : '–', `${A.games || 0}/${T.all.games} parties analysées`),
      tile('Gaffes / partie', bpg !== undefined ? bpg : '–', 'objectif < 0,5 pour viser 1800', bpg > 0.8 ? 'bad' : bpg <= 0.5 ? 'good' : 'warnc')));

    // ---- plan
    if (ov.plan.length) {
      const c = h('div.card', h('h2', '🎯 Ton plan d\'entraînement (généré depuis TES parties)'));
      ov.plan.forEach(p => c.append(h('div.plan-item.p' + p.priority, h('div', { style: { flex: 1 } }, h('b', p.title), h('span.muted', p.detail)), h('a.btn.sm', { href: p.link }, 'Y aller →'))));
      wrap.append(h('div', { style: { marginTop: '14px' } }, c));
    }

    // ---- rating + accuracy charts
    const g1 = h('div.grid.g2', { style: { marginTop: '14px' } });
    const cRating = h('div.card', h('h2', 'Évolution du classement'));
    const cAcc = h('div.card', h('h2', 'Précision par partie'));
    g1.append(cRating, cAcc); wrap.append(g1);
    const colors = { rapid: '#7fa650', blitz: '#f7c631', bullet: '#ca3431', classical: '#5c8bb0', daily: '#a88865' };
    chart(cRating, {
      type: 'line',
      data: { datasets: Object.entries(ov.ratings).map(([k, pts]) => ({ label: TC[k] || k, data: pts.map(p => ({ x: p[0] * 1000, y: p[1] })), borderColor: colors[k] || '#999', backgroundColor: colors[k] || '#999', pointRadius: 0, borderWidth: 2, tension: 0.2 })) },
      options: { scales: { x: { type: 'linear', ticks: { callback: v => new Date(v).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }), maxTicksLimit: 7 } }, y: { grace: '5%' } }, plugins: { legend: { display: Object.keys(ov.ratings).length > 1 } }, interaction: { mode: 'nearest', intersect: false } },
    });
    if (A.accuracy_series?.length) {
      const s = A.accuracy_series;
      chart(cAcc, {
        type: 'scatter',
        data: { datasets: [
          { label: 'Partie', data: s.map(p => ({ x: p[0] * 1000, y: p[1], id: p[2] })), backgroundColor: s.map(p => p[3] === 'win' ? '#6a994e99' : p[3] === 'loss' ? '#bc474999' : '#88888899'), pointRadius: 3 },
          { label: 'Moyenne mobile (10)', type: 'line', data: s.map((p, i) => ({ x: p[0] * 1000, y: movingAvg(s.map(q => q[1]), 10)[i] })), borderColor: '#f7c631', pointRadius: 0, borderWidth: 2, tension: 0.3 },
        ] },
        options: { scales: { x: { type: 'linear', ticks: { callback: v => new Date(v).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }), maxTicksLimit: 7 } }, y: { min: 20, max: 100 } },
          onClick: (e, els, ch) => { const el = els.find(x => x.datasetIndex === 0); if (el) location.hash = '#/review/' + ch.data.datasets[0].data[el.index].id; },
          plugins: { legend: { display: false } } },
      });
    } else cAcc.append(h('div.empty', 'Analyse des parties pour voir ta précision.'));

    if (!A.games) return;

    // ---- phases / errors / tags
    const g2 = h('div.grid.g3', { style: { marginTop: '14px' } });
    const cPh = h('div.card', h('h2', 'Précision par phase'));
    const cEr = h('div.card', h('h2', 'Erreurs par partie'));
    const cTg = h('div.card', h('h2', 'Types d\'erreurs (motifs)'));
    g2.append(cPh, cEr, cTg); wrap.append(g2);
    const phs = ['opening', 'middlegame', 'endgame'].filter(k => A.phase[k]);
    chart(cPh, { type: 'bar', data: { labels: phs.map(k => PHASES[k]), datasets: [{ data: phs.map(k => A.phase[k].accuracy), backgroundColor: ['#5c8bb0', '#7fa650', '#f7c631'], borderRadius: 6 }] },
      options: { scales: { y: { min: 40, max: 100 } }, plugins: { legend: { display: false } } } }, 200);
    cPh.append(h('div.small.muted', 'Perte moyenne de probabilité de gain par coup : ' + phs.map(k => `${PHASES[k]} ${A.phase[k].avg_loss}`).join(' · ')));
    chart(cEr, { type: 'bar', data: { labels: phs.map(k => PHASES[k]), datasets: [
      { label: 'Imprécisions', data: phs.map(k => A.phase[k].inaccuracies_per_game), backgroundColor: '#f7c631' },
      { label: 'Erreurs', data: phs.map(k => A.phase[k].mistakes_per_game), backgroundColor: '#e58f2a' },
      { label: 'Gaffes', data: phs.map(k => A.phase[k].blunders_per_game), backgroundColor: '#ca3431' }] },
      options: { scales: { x: { stacked: true }, y: { stacked: true } } } }, 200);
    if (A.tags.length) {
      chart(cTg, { type: 'bar', data: { labels: A.tags.map(t => TAGS[t.tag] || t.tag), datasets: [{ data: A.tags.map(t => t.per_game), backgroundColor: '#e58f2a', borderRadius: 4 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false } } } }, 200);
      cTg.append(h('div.small.muted', 'Occurrences par partie (erreurs ≥ 10 % de perte).'), h('a.btn.sm', { href: '#/train', style: { marginTop: '8px' } }, 'S\'entraîner dessus →'));
    } else cTg.append(h('div.muted', 'Pas assez de données.'));

    // ---- results
    const g3 = h('div.grid.g3', { style: { marginTop: '14px' } });
    g3.append(
      h('div.card', h('h2', 'Résultats par couleur'), h('div.small.muted', 'Blancs'), wdlBar(T.white), h('div.small.muted', { style: { marginTop: '10px' } }, 'Noirs'), wdlBar(T.black)),
      h('div.card', h('h2', 'Comment tu perds'), ...lossRows(ov)),
      h('div.card', h('h2', 'Selon l\'adversaire'), ...['much_weaker', 'weaker', 'equal', 'stronger', 'much_stronger'].filter(k => ov.by_opponent[k]).map(k =>
        h('div', { style: { marginBottom: '8px' } }, h('div.small.muted', { weaker: 'Plus faible (30-100)', much_weaker: 'Bien plus faible (>100)', equal: 'Niveau égal (±30)', stronger: 'Plus fort (30-100)', much_stronger: 'Bien plus fort (>100)' }[k]), wdlBar(ov.by_opponent[k])))));
    wrap.append(g3);

    // ---- time + conversion
    const tm = A.time || {};
    const g4 = h('div.grid.g3', { style: { marginTop: '14px' } });
    g4.append(
      h('div.card', h('h2', '⏱ Gestion du temps'),
        h('div.muted', 'Temps moyen par coup : ' + (Object.entries(tm.avg_spent || {}).map(([k, v]) => `${PHASES[k]} ${v}s`).join(' · ') || '–')),
        h('p', `Coups joués en < 3 s (hors ouverture) : ${tm.fast_moves || 0}`, tm.fast_bad_pct !== null && tm.fast_bad_pct !== undefined ? ` — dont ${tm.fast_bad_pct}% d'erreurs/gaffes` : ''),
        h('p', `Sous 1 minute à la pendule : ${tm.low_clock_blunder_pct ?? '–'}% de gaffes (${tm.low_clock_blunders || 0}/${tm.low_clock_moves || 0})`)),
      h('div.card', h('h2', '🏁 Conversion'), h('div.val', { style: { fontSize: '28px', fontWeight: 750 } }, A.conversion?.pct !== null && A.conversion?.pct !== undefined ? A.conversion.pct + '%' : '–'),
        h('div.muted', `Parties gagnées parmi celles où tu as eu un avantage décisif (${A.conversion?.won || 0}/${A.conversion?.reached || 0}).`)),
      h('div.card', h('h2', '🛡 Résilience'), h('div.val', { style: { fontSize: '28px', fontWeight: 750 } }, A.resilience?.pct !== null && A.resilience?.pct !== undefined ? A.resilience.pct + '%' : '–'),
        h('div.muted', `Positions très mauvaises sauvées (nulle ou victoire) : ${A.resilience?.saved || 0}/${A.resilience?.reached || 0}.` + (A.avg_first_error_move ? ` Première erreur en moyenne au coup ${A.avg_first_error_move}.` : ''))));
    wrap.append(g4);
  }

  async function todayCard() {
    const t = await api.today();
    const pr = t.progress || {};
    const card = h('div.card', { style: { marginBottom: '14px', borderColor: '#4a5d38' } });
    card.append(h('div.row', h('h2', { style: { margin: 0 } }, '📅 Séance du jour'),
      h('span.muted', t.minutes ? `≈ ${t.minutes} min restantes` : 'Séance terminée 🎉'),
      h('span.right', t.streak ? h('b', `🔥 ${t.streak} jour${t.streak > 1 ? 's' : ''} de suite`) : h('span.muted', 'Commence une série aujourd\'hui'))));
    const list = h('div', { style: { marginTop: '10px' } });
    t.tasks.forEach(k => {
      const ok = k.goal && k.done >= k.goal;
      const pct = k.goal ? Math.min(100, 100 * k.done / k.goal) : 0;
      list.append(h('div.row', { style: { padding: '8px 0', borderTop: '1px solid var(--line)', flexWrap: 'nowrap' } },
        h('span', { style: { fontSize: '20px', width: '26px' } }, ok ? '✅' : k.icon),
        h('div', { style: { flex: 1, minWidth: 0 } }, h('b', k.title), h('div.small.muted', k.detail),
          k.goal ? h('div.bar', { style: { marginTop: '4px', maxWidth: '260px' } }, h('i', { style: { width: pct + '%' } })) : null),
        k.goal ? h('span.mono.muted', `${k.done}/${k.goal}`) : null,
        h('a.btn.sm' + (ok ? '' : '.primary'), { href: k.link }, ok ? 'Refaire' : 'Go →')));
    });
    card.append(list);
    if (pr.current) {
      const span = Math.max(1, pr.target - (pr.start || pr.current));
      const pct = Math.max(0, Math.min(100, 100 * (pr.current - (pr.start || pr.current)) / span));
      card.append(h('div', { style: { marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--line)' } },
        h('div.row', h('b', `🎯 Objectif ${pr.target}`), h('span.muted', `${pr.current} actuellement (${pr.tc})`),
          h('span.right.small.muted', pr.eta_months ? `À ce rythme (${pr.slope_per_month > 0 ? '+' : ''}${pr.slope_per_month}/mois) : ~${pr.eta_months} mois` : pr.slope_per_month !== null && pr.slope_per_month !== undefined ? `Tendance : ${pr.slope_per_month > 0 ? '+' : ''}${pr.slope_per_month}/mois` : 'Joue plus de parties pour estimer ton rythme')),
        h('div.progress', { style: { marginTop: '6px' } }, h('div', { style: { width: pct + '%' } }))));
    }
    return card;
  }

  function lossRows(ov) {
    const names = { time: 'Au temps', mate: 'Mat', resign: 'Abandon', abandon: 'Déconnexion', draw: 'Nulle', other: 'Autre' };
    const tot = Object.values(ov.loss_by).reduce((a, b) => a + b, 0) || 1;
    return Object.entries(ov.loss_by).sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      h('div', { style: { marginBottom: '8px' } }, h('div.row', h('span', names[k] || k), h('span.right.muted', `${v} (${Math.round(100 * v / tot)}%)`)), h('div.bar', h('i', { style: { width: 100 * v / tot + '%', background: k === 'time' ? '#e58f2a' : '#bc4749' } }))));
  }

  await draw();
  return () => { charts.forEach(c => c.destroy()); charts = []; };
}
