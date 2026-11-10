// Small helpers shared by all views.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Tiny hyperscript: h('div.card#id', {onclick}, 'text', child, ...) */
export function h(tag, attrs, ...children) {
  const m = tag.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  (m[2].match(/[.#][\w-]+/g) || []).forEach(t => t[0] === '.' ? el.classList.add(t.slice(1)) : (el.id = t.slice(1)));
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') v.split(' ').filter(Boolean).forEach(c => el.classList.add(c));
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = c => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const CLS = {
  brilliant: { label: 'Brillant', sym: '!!', color: '#1baca6' },
  great: { label: 'Très bon coup', sym: '!', color: '#5c8bb0' },
  best: { label: 'Meilleur coup', sym: '★', color: '#7fa650' },
  excellent: { label: 'Excellent', sym: '✓', color: '#96bc4b' },
  good: { label: 'Bon', sym: '✓', color: '#a3b18a' },
  book: { label: 'Théorie', sym: '📖', color: '#a88865' },
  inaccuracy: { label: 'Imprécision', sym: '?!', color: '#f7c631' },
  mistake: { label: 'Erreur', sym: '?', color: '#e58f2a' },
  blunder: { label: 'Gaffe', sym: '??', color: '#ca3431' },
};

export const TAGS = {
  hung_piece: 'Pièce en prise', missed_material: 'Gain de matériel manqué', missed_fork: 'Fourchette manquée',
  allowed_fork: 'Fourchette autorisée', mate_missed: 'Mat manqué', mate_allowed: 'Mat autorisé',
  threw_advantage: 'Avantage gâché', missed_opportunity: 'Faute adverse non punie', time_trouble: 'Zeitnot', too_fast: 'Trop rapide',
};

export const PHASES = { opening: 'Ouverture', middlegame: 'Milieu de partie', endgame: 'Finale' };
export const TC = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapide', classical: 'Classique', daily: 'Correspondance' };

/** Format an evaluation (white POV centipawns) as +1.23 / M3. */
export function fmtEval(cp, mate) {
  if (mate !== null && mate !== undefined) return mate === 0 ? '#' : (mate > 0 ? '+M' : '-M') + Math.abs(mate);
  if (cp === null || cp === undefined) return '–';
  if (Math.abs(cp) >= 9000) return cp > 0 ? '+M' : '-M';
  const v = (cp / 100).toFixed(1);
  return (cp > 0 ? '+' : '') + v;
}

export function winPct(cp) {
  cp = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function fmtDate(ts) {
  return new Date(ts * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: '2-digit' });
}

export function fmtClock(ms) {
  if (ms === null || ms === undefined) return '';
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return m + ':' + (sec < 10 ? '0' : '') + (s < 20 ? sec.toFixed(1) : Math.floor(sec));
}

export function resultBadge(r) {
  const map = { win: ['V', 'win'], loss: ['D', 'loss'], draw: ['N', 'draw'] };
  const [t, c] = map[r] || ['?', ''];
  return h('span.badge.res-' + c, t);
}

export function toast(msg, kind = '') {
  let t = $('#toasts');
  const el = h('div.toast.' + (kind || 'info'), msg);
  t.append(el);
  setTimeout(() => el.classList.add('out'), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ---------------------------------------------------------------- sounds (WebAudio, no assets)
let actx = null;
export function playSound(kind = 'move', enabled = true) {
  if (!enabled) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    const f = { move: 520, capture: 330, check: 700, error: 160, ok: 880 }[kind] || 520;
    o.frequency.value = f; o.type = kind === 'error' ? 'sawtooth' : 'triangle';
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, actx.currentTime + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + (kind === 'capture' ? 0.12 : 0.08));
    o.start(); o.stop(actx.currentTime + 0.14);
  } catch (e) { /* ignore */ }
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem('cc.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cc.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

export const THEME_FR = {
  mateIn1: 'Mat en 1', mateIn2: 'Mat en 2', mateIn3: 'Mat en 3', mateIn4: 'Mat en 4', mateIn5: 'Mat en 5', fork: 'Fourchette', pin: 'Clouage',
  skewer: 'Rayon X', discoveredAttack: 'Attaque à la découverte', discoveredCheck: 'Échec à la découverte', doubleCheck: 'Double échec',
  hangingPiece: 'Pièce en prise', winMaterial: 'Gain de matériel', sacrifice: 'Sacrifice', deflection: 'Déviation', attraction: 'Attraction',
  interference: 'Interférence', clearance: 'Dégagement', intermezzo: 'Coup intermédiaire', quietMove: 'Coup calme', defensiveMove: 'Coup défensif',
  trappedPiece: 'Pièce piégée', exposedKing: 'Roi exposé', kingsideAttack: 'Attaque côté roi', queensideAttack: 'Attaque côté dame',
  backRankMate: 'Mat du couloir', smotheredMate: 'Mat étouffé', promotion: 'Promotion', advancedPawn: 'Pion avancé', endgame: 'Finale',
  rookEndgame: 'Finale de tours', pawnEndgame: 'Finale de pions', bishopEndgame: 'Finale de fous', knightEndgame: 'Finale de cavaliers',
  queenEndgame: 'Finale de dames', zugzwang: 'Zugzwang', capturingDefender: 'Capture du défenseur', xRayAttack: 'Rayon X',
};

/** Progressive hint text from puzzle themes. */
export function hintText(themes = [], mateIn = null) {
  const t = new Set(themes);
  const m = themes.find(x => /^mateIn\d/.test(x));
  if (m) return `Il y a un ${THEME_FR[m].toLowerCase()} à trouver — cherche les échecs.`;
  if (mateIn) return `Il y a un mat en ${mateIn} — cherche les échecs.`;
  if (t.has('fork')) return 'Une fourchette est possible : une pièce qui attaque deux cibles à la fois.';
  if (t.has('hangingPiece')) return 'Une pièce adverse est mal protégée : regarde les captures.';
  if (t.has('winMaterial')) return 'Tu peux gagner du matériel.';
  if (t.has('sacrifice')) return 'Un sacrifice ouvre la position : le coup juste donne quelque chose pour gagner plus.';
  if (t.has('skewer')) return 'Pense au rayon X : attaquer une pièce de valeur pour en gagner une derrière.';
  if (t.has('pin')) return 'Pense au clouage : une pièce ne peut pas bouger sans en exposer une plus précieuse.';
  if (t.has('discoveredAttack')) return 'Pense à l\'attaque à la découverte : déplacer une pièce pour démasquer une autre.';
  if (t.has('backRankMate')) return 'Le roi adverse est coincé sur sa dernière rangée.';
  if (t.has('promotion')) return 'Un pion peut aller à la promotion.';
  if (t.has('defensiveMove')) return 'Tu es sous pression : cherche le seul coup qui tient la position.';
  if (t.has('quietMove')) return 'Pas de capture ni d\'échec ici : cherche un coup calme qui crée une menace.';
  if (t.has('trappedPiece')) return 'Une pièce adverse n\'a plus de case sûre.';
  const th = themes.filter(x => THEME_FR[x]).map(x => THEME_FR[x]);
  return th.length ? 'Thème : ' + th.slice(0, 2).join(', ') + '.' : 'Cherche dans l\'ordre : échecs, captures, menaces.';
}
