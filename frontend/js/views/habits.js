import { api } from '../api.js';
import { h, store } from '../util.js';

const col = pct => pct == null ? 'var(--bg4)' : pct < 40 ? '#ca3431' : pct < 50 ? '#e58f2a' : '#7fa650';

function bar(label, pct, n, max = 100, text = null) {
  if (n < 5) pct = null;
  return h('div.hbar', h('div.lbl', label),
    h('div.bar', h('i', { style: { width: pct == null ? '0%' : Math.min(100, 100 * pct / max) + '%', background: col(pct) } })),
    h('div.val', pct == null ? h('span.dim', `${n} · trop peu`) : `${text ?? pct + ' %'} · ${n}`));
}

export async function render(root) {
  const host = h('div');
  root.append(host);
  let tc = store.get('hb.tc', 'rapid'), days = store.get('hb.days', 0);

  async function draw() {
    host.innerHTML = '';
    const sel = h('select', { onchange: e => { tc = e.target.value; store.set('hb.tc', tc); draw(); } },
      [['all', 'Toutes cadences'], ['rapid', 'Rapide'], ['blitz', 'Blitz'], ['bullet', 'Bullet'], ['classical', 'Classique']].map(([v, l]) => h('option', { value: v, selected: tc === v }, l)));
    const sel2 = h('select', { onchange: e => { days = +e.target.value; store.set('hb.days', days); draw(); } },
      [[0, 'Tout l\'historique'], [30, '30 derniers jours'], [90, '90 derniers jours']].map(([v, l]) => h('option', { value: v, selected: days === v }, l)));
    host.append(h('div.page-head', h('div', h('h1', 'Habitudes'), h('div.muted', 'Comment tu gères ton temps et tes séries de défaites — souvent là que se perdent 100 points.')),
      h('div.row.right', sel, sel2)));
    const d = await api.habits({ tc, days: days || undefined });
    const t = d.tilt, tm = d.time;

    const advices = [...t.advice, ...(tm.advice || [])];
    host.append(h('div.card', h('h2', '🎯 Ce que je te conseille'),
      advices.length ? advices.map(a => h('div.advice', a.text)) : h('div.muted', t.games < 30 ? 'Pas assez de parties pour conclure (importe/analyse plus de parties).' : 'Rien d\'alarmant dans tes habitudes sur cette période.')));

    const grid = h('div.grid.g2', { style: { marginTop: '14px' } });
    // ---- tilt
    const a = t.after;
    grid.append(h('div.card', h('h3', '🔥 Après une défaite (score = victoires + ½ nulles)'),
      h('div.small.muted', `${t.games} parties · ${t.sessions} séances (≈ ${t.avg_session} parties) · moyenne ${t.baseline ?? '–'} %`),
      bar('1re partie de la séance', a.start.score, a.start.n), bar('après une victoire', a.win.score, a.win.n),
      bar('après une défaite', a.loss.score, a.loss.n), bar('après 2 défaites', a.loss2.score, a.loss2.n), bar('après 3 défaites', a.loss3.score, a.loss3.n)));
    grid.append(h('div.card', h('h3', '⏱ Fatigue : n-ième partie de la séance'),
      ...Object.entries(t.by_index).map(([k, v]) => bar(k === '5' ? '5e et plus' : `partie ${k}`, v.score, v.n)),
      h('h3', { style: { marginTop: '14px' } }, '🕐 Selon l\'heure'),
      ...Object.entries(t.by_hour).map(([k, v]) => bar(k, v.score, v.n))));
    // ---- time
    if (tm.moves) {
      grid.append(h('div.card', h('h3', '⚡ Erreurs/gaffes selon le temps passé sur le coup'),
        h('div.small.muted', `${tm.moves} de tes coups analysés (hors théorie). Les positions difficiles font réfléchir plus longtemps : lis ça avec recul.`),
        ...tm.spent.map(s => bar(s.label, s.err_pct, s.n, 30, s.err_pct + ' %')),
        h('h3', { style: { marginTop: '14px' } }, 'Temps moyen par coup'),
        h('div.row.small', ['opening', 'middlegame', 'endgame'].map(p => h('span', { style: { marginRight: '16px' } }, ({ opening: 'Ouverture', middlegame: 'Milieu', endgame: 'Finale' })[p] + ' : ', h('b', tm.phase_avg_s[p] != null ? tm.phase_avg_s[p] + ' s' : '–'))))));
      const pr = tm.pressure;
      grid.append(h('div.card', h('h3', '🚨 Zeitnot'),
        bar('temps normal', pr.ok_err_pct, pr.ok_n, 30, pr.ok_err_pct + ' % d\'erreurs'),
        bar('< 10 % du temps', pr.low_err_pct, pr.low_n, 30, pr.low_err_pct + ' % d\'erreurs'),
        h('div.small.muted', { style: { marginTop: '10px' } }, `Défaites au temps : ${tm.timeouts} sur ${tm.losses}. Parties finies avec presque plus de temps : ${tm.trouble_games}` + (tm.trouble_score != null ? ` (score ${tm.trouble_score} %)` : '') + '.')));
    } else {
      grid.append(h('div.card.empty', 'Analyse tes parties pour voir les statistiques de temps.'));
    }
    host.append(grid);
  }
  await draw();
}
