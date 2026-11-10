import { api } from '../api.js';
import { state, loadSettings } from '../state.js';
import { h, toast } from '../util.js';

export async function render(root) {
  const s = await api.settings();
  const st = await api.status();
  const inp = (key, type = 'text', extra = {}) => {
    const el = h('input', { type, value: s[key], ...extra });
    el.addEventListener('change', () => { s[key] = type === 'number' ? +el.value : el.value; });
    return el;
  };
  const chk = key => { const el = h('input', { type: 'checkbox', checked: !!s[key] }); el.addEventListener('change', () => { s[key] = el.checked; }); return el; };
  const sel = (key, opts) => { const el = h('select', opts.map(([v, l]) => h('option', { value: v, selected: String(s[key]) === String(v) }, l))); el.addEventListener('change', () => { s[key] = isNaN(+el.value) ? el.value : +el.value; }); return el; };
  const importStatus = h('div');

  async function save() {
    const r = await api.saveSettings(s);
    await loadSettings();
    toast('Paramètres enregistrés', 'ok');
    return r;
  }

  root.append(
    h('div.page-head', h('div', h('h1', 'Paramètres'), h('div.muted', 'Tout reste en local sur ton Mac.'))),
    h('div.grid.g2',
      h('div.card', h('h2', 'Comptes'),
        h('label.field', 'Pseudo chess.com', inp('chesscom_user', 'text', { placeholder: 'ex : magnus' })),
        h('label.field', 'Pseudo lichess (optionnel)', inp('lichess_user', 'text')),
        h('label.field', 'Importer les X derniers mois', sel('import_months', [[1, '1 mois'], [3, '3 mois'], [6, '6 mois'], [12, '12 mois'], [24, '24 mois'], [0, 'Tout l\'historique']])),
        h('label.switch', chk('auto_import'), 'Importer les nouvelles parties automatiquement à l\'ouverture'),
        h('div'),
        h('label.switch', chk('auto_analyze'), 'Analyser automatiquement après import'),
        h('div.row', { style: { marginTop: '14px' } },
          h('button.btn.primary', { onclick: async () => { await save(); await api.startImport(); toast('Import lancé…'); watchImport(); } }, '⬇ Enregistrer et importer'),
          h('button.btn', { onclick: save }, 'Enregistrer')),
        importStatus),
      h('div.card', h('h2', 'Analyse moteur'),
        h('label.field', 'Qualité d\'analyse', sel('quality', [['fast', 'Rapide (~5 s/partie)'], ['balanced', 'Équilibrée — recommandé (~15 s/partie)'], ['max', 'Maximale (~1 min/partie)']]),
          h('small', 'Chaque partie est balayée vite, puis les coups douteux sont revérifiés en profondeur (comparaison à profondeur égale + tablebases de finales).')),
        h('label.field', 'Moteurs en parallèle', inp('threads', 'number', { min: 1, max: 16 }), h('small', 'Ton Mac a 10 cœurs : 8 est idéal.')),
        h('label.switch', chk('pause_on_battery'), 'Mettre en pause la mise à jour automatique des anciennes analyses quand le Mac est sur batterie'),
        h('label.field', 'Mémoire par moteur (Mo)', inp('hash_mb', 'number', { min: 16, max: 2048 })),
        h('div.small.muted', `Moteur : ${st.engine} · tablebases : ${st.tablebases ? 'oui ✓' : 'non'} · base de tactiques : ${st.tactics_db ? 'oui ✓' : 'non'}`),
        st.outdated ? h('div.feedback.info', `${st.outdated} partie(s) analysée(s) avec l'ancienne version (moins précise). Elles sont mises à jour automatiquement, les plus récentes d'abord.`) : null,
        h('div.row', { style: { marginTop: '14px' } },
          h('button.btn', { onclick: save }, 'Enregistrer'),
          h('button.btn', { onclick: async () => { await save(); const r = await api.analyze({ force: true }); toast(`${r.queued} parties en file de ré-analyse`, 'ok'); } }, '↻ Tout ré-analyser'))),
      h('div.card', h('h2', 'Objectifs'),
        h('label.field', 'Classement visé', inp('target_rating', 'number', { min: 800, max: 3000 })),
        h('label.field', 'Puzzles « mes erreurs » par jour', inp('daily_goal_puzzles', 'number', { min: 0, max: 100 })),
        h('label.field', 'Tactiques classées par jour', inp('daily_goal_tactics', 'number', { min: 0, max: 200 })),
        h('div', { style: { marginTop: '8px' } }, h('button.btn', { onclick: save }, 'Enregistrer'))),
      h('div.card', h('h2', 'Affichage'),
        h('label.field', 'Thème de l\'échiquier', sel('board_theme', [['green', 'Vert'], ['brown', 'Bois'], ['blue', 'Bleu'], ['gray', 'Gris'], ['purple', 'Violet']])),
        h('label.switch', chk('sound'), 'Sons'),
        h('div', { style: { marginTop: '14px' } }, h('button.btn', { onclick: save }, 'Enregistrer'))),
      h('div.card', h('h2', 'Importer des PGN'),
        h('div.muted', 'Colle ici des parties jouées ailleurs (OTB, autre site…). Ton pseudo doit apparaître dans les en-têtes White/Black.'),
        (() => {
          const ta = h('textarea', { rows: 6, placeholder: '[Event "…"]\n[White "…"]\n…' });
          return h('div', ta, h('button.btn', { style: { marginTop: '8px' }, onclick: async () => { const r = await api.importPgn(ta.value); toast(`${r.imported} partie(s) importée(s)`, 'ok'); ta.value = ''; } }, 'Importer'));
        })())));

  function watchImport() {
    const t = setInterval(async () => {
      const x = await api.status();
      importStatus.innerHTML = '';
      importStatus.append(h('div.pill', { style: { marginTop: '10px' } }, x.import.running ? h('div.spinner') : null, x.import.error ? '⚠ ' + x.import.error : x.import.message));
      if (!x.import.running) { clearInterval(t); }
    }, 1000);
  }
  if (st.import.running) watchImport();
}
