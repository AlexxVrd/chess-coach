import { api } from '../api.js';
import { h, store, fmtDate, resultBadge, toast, TC, debounce } from '../util.js';

export async function render(root) {
  const f = store.get('games.f', { tc: '', result: '', color: '', q: '', analyzed: '', starred: '' });
  let offset = 0, total = 0;
  const PAGE = 40;

  const tbody = h('tbody');
  const more = h('button.btn', { onclick: () => load(false) }, 'Charger plus');
  const info = h('span.muted');
  const sel = (key, opts) => {
    const s = h('select', { onchange: () => { f[key] = s.value; store.set('games.f', f); load(true); } },
      opts.map(([v, l]) => h('option', { value: v, selected: f[key] === v }, l)));
    return s;
  };
  const search = h('input', { type: 'text', placeholder: 'Adversaire…', value: f.q, oninput: debounce(e => { f.q = e.target.value; store.set('games.f', f); load(true); }, 300) });

  const status = h('div');
  async function refreshStatus() {
    const s = await api.status();
    status.innerHTML = '';
    const q = s.queue;
    if (s.import.running) status.append(h('div.pill', h('div.spinner'), `Import : ${s.import.message}`));
    if (q.running) status.append(h('div.pill', h('div.spinner'), `Analyse en cours : partie ${q.done + 1} (${q.ply}/${q.total} positions) · ${q.pending} en attente`,
      h('button.btn.sm.right', { onclick: async () => { await api.cancelAnalyze(); toast('Analyse annulée'); } }, 'Annuler')));
    if (s.import.error) status.append(h('div.feedback.ko', s.import.error));
  }

  root.append(
    h('div.page-head', h('div', h('h1', 'Parties'), info),
      h('div.right.row',
        h('button.btn', { onclick: doImport }, '⬇ Importer'),
        h('button.btn.primary', { onclick: async () => { const r = await api.analyze({}); toast(`${r.queued} parties en file d'analyse`, 'ok'); refreshStatus(); } }, '⚡ Analyser les nouvelles'))),
    status,
    h('div.card', { style: { marginBottom: '14px' } }, h('div.row',
      sel('tc', [['', 'Toutes cadences'], ['rapid', 'Rapide'], ['blitz', 'Blitz'], ['bullet', 'Bullet'], ['classical', 'Classique'], ['daily', 'Correspondance']]),
      sel('result', [['', 'Tous résultats'], ['win', 'Victoires'], ['draw', 'Nulles'], ['loss', 'Défaites']]),
      sel('color', [['', 'Blancs + Noirs'], ['w', 'Blancs'], ['b', 'Noirs']]),
      sel('analyzed', [['', 'Analysées ou non'], ['1', 'Analysées'], ['0', 'Non analysées']]),
      sel('starred', [['', 'Toutes'], ['1', '★ Favoris']]),
      search)),
    h('div.card', { style: { padding: 0, overflow: 'hidden' } },
      h('table', h('thead', h('tr', ['', 'Date', 'Adversaire', 'Ouverture', 'Cadence', 'Préc.', 'Gaffes', 'Err.', ''].map(t => h('th', t)))), tbody)),
    h('div', { style: { textAlign: 'center', marginTop: '14px' } }, more));

  async function doImport() {
    const s = await api.settings();
    if (!s.chesscom_user && !s.lichess_user) { toast('Renseigne ton pseudo dans les paramètres', 'err'); location.hash = '#/settings'; return; }
    await api.startImport();
    toast('Import lancé…');
    const t = setInterval(async () => { await refreshStatus(); const st = await api.status(); if (!st.import.running) { clearInterval(t); load(true); toast(st.import.message, 'ok'); } }, 1200);
  }

  async function load(reset) {
    if (reset) { offset = 0; tbody.innerHTML = ''; }
    const r = await api.games({ ...f, limit: PAGE, offset });
    total = r.total;
    r.games.forEach(g => tbody.append(row(g)));
    offset += r.games.length;
    more.style.display = offset < total ? '' : 'none';
    info.textContent = `${total} parties`;
    if (!total) tbody.append(h('tr', h('td', { colspan: 9 }, h('div.empty', 'Aucune partie. Importe tes parties depuis les paramètres ou ici.'))));
  }

  function row(g) {
    const mine = g.user_color === 'w';
    const opp = mine ? g.black : g.white, oppElo = mine ? g.black_elo : g.white_elo;
    const acc = mine ? g.acc_white : g.acc_black;
    const star = h('span.star' + (g.starred ? '.on' : ''), { onclick: async e => { e.stopPropagation(); g.starred = g.starred ? 0 : 1; star.classList.toggle('on'); await api.gameMeta(g.id, { starred: g.starred }); } }, '★');
    return h('tr.click', { onclick: () => location.hash = '#/review/' + g.id },
      h('td', resultBadge(g.user_result)),
      h('td.muted', fmtDate(g.played_at)),
      h('td', h('span.pcolor', { style: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '2px', marginRight: '6px', background: mine ? '#eee' : '#222', border: '1px solid #777' } }), opp, h('span.dim', ` (${oppElo || '?'})`)),
      h('td.muted', g.opening ? g.opening.split(':')[0] : '–'),
      h('td.muted', `${TC[g.time_class] || g.time_class}`),
      h('td', g.analyzed ? h('b', { class: acc >= 85 ? 'good' : acc < 65 ? 'bad' : '' }, acc ?? '–') : h('span.dim', '–')),
      h('td', g.analyzed ? (g.blunders ? h('b.bad', g.blunders) : h('span.dim', '0')) : ''),
      h('td', g.analyzed ? (g.mistakes ? h('b.warnc', g.mistakes) : h('span.dim', '0')) : ''),
      h('td', star));
  }

  await load(true);
  await refreshStatus();
  const t = setInterval(() => { if (!document.hidden) refreshStatus(); }, 3000);
  const t2 = setInterval(async () => { if (document.hidden) return; const s = await api.status(); if (s.queue.running && offset <= PAGE) load(true); }, 15000);
  return () => { clearInterval(t); clearInterval(t2); };
}
