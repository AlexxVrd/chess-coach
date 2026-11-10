import { api } from './api.js';
import { loadSettings, state } from './state.js';
import { h, $ } from './util.js';

const ROUTES = {
  dashboard: ['📊', 'Tableau de bord', () => import('./views/dashboard.js')],
  games: ['♟', 'Parties', () => import('./views/games.js')],
  openings: ['📖', 'Ouvertures', () => import('./views/openings.js')],
  repertoire: ['🌳', 'Répertoire', () => import('./views/repertoire.js')],
  train: ['🧩', 'Entraînement', () => import('./views/train.js')],
  calcul: ['🧮', 'Calcul', () => import('./views/calc.js')],
  sparring: ['⚔️', 'Sparring', () => import('./views/sparring.js')],
  endgames: ['🏁', 'Finales', () => import('./views/endgames.js')],
  habits: ['🧠', 'Habitudes', () => import('./views/habits.js')],
  analysis: ['🔬', 'Analyse libre', () => import('./views/analysis.js')],
  settings: ['⚙️', 'Paramètres', () => import('./views/settings.js')],
};
ROUTES.review = [null, null, () => import('./views/review.js')];

let cleanup = null;
let token = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [pathPart, query] = raw.split('?');
  const [name, id] = pathPart.split('/');
  const params = Object.fromEntries(new URLSearchParams(query || ''));
  if (id) params.id = id;
  return { name, params };
}

async function route() {
  const my = ++token;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const { name, params } = parseHash();
  const r = ROUTES[name] || ROUTES.dashboard;
  const view = $('#view');
  view.innerHTML = '';
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.r === (name === 'review' ? 'games' : name)));
  try {
    const mod = await r[2]();
    if (my !== token) return;
    const c = await mod.render(view, params);
    if (my !== token) { c && c(); return; }
    cleanup = c || null;
  } catch (e) {
    console.error(e);
    view.append(h('div.card', h('h2', 'Erreur'), h('pre', String(e.stack || e))));
  }
}

function buildNav() {
  const nav = $('#nav');
  for (const [k, v] of Object.entries(ROUTES)) {
    if (!v[1]) continue;
    nav.append(h('a', { href: '#/' + k, 'data-r': k }, h('span.ic', v[0]), v[1], k === 'train' ? h('span.count#dueCount', { style: { display: 'none' } }) : null));
  }
}

async function pollStatus() {
  if (document.hidden) { setTimeout(pollStatus, 30000); return; }     // onglet caché : on ne réveille pas le processeur
  try {
    const s = await api.status();
    state.status = s;
    const foot = $('#sidefoot');
    foot.innerHTML = '';
    const q = s.queue;
    if (q.running) {
      foot.append(h('div.pill', q.paused ? h('div', '🔋') : h('div.spinner'), h('div', h('div', q.paused ? 'En pause (batterie)' : `Analyse… ${q.done} faites`), h('div.small.dim', q.paused ? `${q.pending} en attente — branche le Mac` : `${q.pending} en attente`))));
    } else if (s.import.running) {
      foot.append(h('div.pill', h('div.spinner'), 'Import…'));
    }
    foot.append(h('div', `${s.games} parties · ${s.analyzed} analysées`));
    const ps = await api.puzzleStats();
    const c = $('#dueCount');
    if (c) { c.style.display = ps.due ? '' : 'none'; c.textContent = ps.due; }
  } catch { /* server busy */ }
  setTimeout(pollStatus, state.status && (state.status.queue.running || state.status.import.running) ? 3000 : 20000);
}

(async function main() {
  await loadSettings();
  buildNav();
  window.addEventListener('hashchange', route);
  api.autoImport().catch(() => {});
  await route();
  pollStatus();
})();
