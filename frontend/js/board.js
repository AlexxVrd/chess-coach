import { Chess } from '../vendor/chess.js';
import { h } from './util.js';

const FILES = 'abcdefgh';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function parsePlacement(fen) {
  const out = {};
  const rows = fen.split(' ')[0].split('/');
  rows.forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { f += +ch; continue; }
      out[FILES[f] + (8 - i)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
      f++;
    }
  });
  return out;
}

/**
 * Interactive SVG-piece chessboard.
 * opts: orientation 'w'|'b', interactive, movable ('w'|'b'|'both'), onMove({from,to,promotion,uci,san}), theme
 */
export class Board {
  constructor(parent, opts = {}) {
    this.opts = { orientation: 'w', interactive: false, movable: 'both', ...opts };
    this.o = this.opts.orientation;
    this.chess = new Chess();
    this.pieces = new Map();       // square -> {el, code}
    this.sqEls = {};
    this.selected = null;
    this.targets = [];
    this.marks = { last: [], check: null, hint: null, extra: [] };
    this.root = h('div.board', { 'data-theme': opts.theme || 'green' });
    this.sqLayer = h('div.sq-layer');
    this.pieceLayer = h('div.piece-layer');
    this.badgeLayer = h('div.badge-layer');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('viewBox', '0 0 8 8');
    this.svg.classList.add('arrow-layer');
    this.root.append(this.sqLayer, this.pieceLayer, this.svg, this.badgeLayer);
    parent.append(this.root);
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const name = FILES[f] + (r + 1);
      const el = h('div.sq' + ((f + r) % 2 === 0 ? '.dark' : '.light'));
      el.dataset.sq = name;
      this.sqEls[name] = el;
      this.sqLayer.append(el);
    }
    this.layoutSquares();
    this.root.addEventListener('pointerdown', e => this.onDown(e));
    this.root.addEventListener('contextmenu', e => e.preventDefault());
    this.setFen(opts.fen || START_FEN);
  }

  // ------------------------------------------------------------ geometry
  xy(sq) {
    const f = FILES.indexOf(sq[0]), r = +sq[1] - 1;
    return this.o === 'w' ? [f, 7 - r] : [7 - f, r];
  }
  place(el, sq) {
    const [x, y] = this.xy(sq);
    el.style.left = x * 12.5 + '%';
    el.style.top = y * 12.5 + '%';
  }
  layoutSquares() {
    for (const [name, el] of Object.entries(this.sqEls)) {
      this.place(el, name);
      el.innerHTML = '';
      const [x, y] = this.xy(name);
      if (x === 0) el.append(h('span.coord.rank', name[1]));
      if (y === 7) el.append(h('span.coord.file', name[0]));
    }
  }
  sqFromEvent(e) {
    const rect = this.root.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.o === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
  }

  // ------------------------------------------------------------ state
  setOrientation(o) {
    this.o = o;
    this.layoutSquares();
    for (const [sq, p] of this.pieces) this.place(p.el, sq);
    this.redrawArrows();
    this.redrawBadge();
  }
  flip() { this.setOrientation(this.o === 'w' ? 'b' : 'w'); }
  setTheme(t) { this.root.dataset.theme = t; }

  get fen() { return this.chess.fen(); }
  get turn() { return this.chess.turn(); }

  setFen(fen, hint) {
    try { this.chess.load(fen); } catch { try { this.chess = new Chess(); this.chess.load(fen, { skipValidation: true }); } catch { /* ignore */ } }
    const place = parsePlacement(fen);
    const old = this.pieces;
    const next = new Map();
    if (hint && old.has(hint.from) && place[hint.to]) {
      const p = old.get(hint.from);
      old.delete(hint.from);
      if (old.has(hint.to)) { old.get(hint.to).el.remove(); old.delete(hint.to); }
      if (p.code !== place[hint.to]) { p.code = place[hint.to]; p.el.style.backgroundImage = `url(pieces/${p.code}.svg)`; }
      this.place(p.el, hint.to);
      next.set(hint.to, p);
    }
    for (const [sq, code] of Object.entries(place)) {
      if (next.has(sq)) continue;
      const o = old.get(sq);
      if (o && o.code === code) { next.set(sq, o); old.delete(sq); continue; }
      const el = h('div.piece');
      el.style.backgroundImage = `url(pieces/${code}.svg)`;
      this.place(el, sq);
      this.pieceLayer.append(el);
      next.set(sq, { el, code });
    }
    for (const p of old.values()) p.el.remove();
    this.pieces = next;
    this.clearSelection();
    this.updateMarks({ check: this.chess.inCheck() ? this.kingSquare(this.chess.turn()) : null });
  }

  kingSquare(color) {
    for (const [sq, p] of this.pieces) if (p.code === color + 'K') return sq;
    return null;
  }

  /** Apply a move (uci) with animation. Returns chess.js move or null. */
  play(uci) {
    const from = uci.slice(0, 2), to = uci.slice(2, 4), promotion = uci[4];
    let m;
    try { m = this.chess.move({ from, to, promotion }); } catch { return null; }
    if (!m) return null;
    this.setFen(this.chess.fen(), { from, to });
    this.updateMarks({ last: [from, to] });
    return m;
  }

  // ------------------------------------------------------------ marks
  updateMarks(patch) {
    Object.assign(this.marks, patch);
    for (const el of Object.values(this.sqEls)) el.classList.remove('last', 'check', 'hint', 'sel', 'x1', 'x2');
    this.marks.last.forEach(s => s && this.sqEls[s].classList.add('last'));
    if (this.marks.check) this.sqEls[this.marks.check].classList.add('check');
    if (this.marks.hint) this.sqEls[this.marks.hint].classList.add('hint');
    if (this.selected) this.sqEls[this.selected].classList.add('sel');
    (this.marks.extra || []).forEach(([s, c]) => this.sqEls[s].classList.add(c));
  }
  setLast(from, to) { this.updateMarks({ last: from ? [from, to] : [] }); }
  setHint(sq) { this.updateMarks({ hint: sq }); }

  setBadge(sq, info) {
    this.badge = sq && info ? { sq, info } : null;
    this.redrawBadge();
  }
  redrawBadge() {
    this.badgeLayer.innerHTML = '';
    if (!this.badge) return;
    const [x, y] = this.xy(this.badge.sq);
    const b = h('div.mbadge', this.badge.info.sym);
    b.style.background = this.badge.info.color;
    b.style.left = (x + 1) * 12.5 + '%';
    b.style.top = y * 12.5 + '%';
    this.badgeLayer.append(b);
  }

  setArrows(arrows) {
    this.arrows = arrows || [];
    this.redrawArrows();
  }
  redrawArrows() {
    this.svg.innerHTML = '';
    for (const a of this.arrows || []) {
      const [x1, y1] = this.xy(a.from), [x2, y2] = this.xy(a.to);
      const ax = x1 + 0.5, ay = y1 + 0.5, bx = x2 + 0.5, by = y2 + 0.5;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (!len) continue;
      const ux = dx / len, uy = dy / len, px = -uy, py = ux;
      const w = a.width || 0.14, hw = w * 2.2, hl = 0.36;
      const sx = ax + ux * 0.18, sy = ay + uy * 0.18;               // start slightly off the center
      const ex = bx - ux * 0.08, ey = by - uy * 0.08;               // tip
      const bx2 = ex - ux * hl, by2 = ey - uy * hl;                 // base of head
      const pts = [
        [sx + px * w / 2, sy + py * w / 2], [bx2 + px * w / 2, by2 + py * w / 2], [bx2 + px * hw, by2 + py * hw],
        [ex, ey], [bx2 - px * hw, by2 - py * hw], [bx2 - px * w / 2, by2 - py * w / 2], [sx - px * w / 2, sy - py * w / 2],
      ];
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('points', pts.map(p => p.join(',')).join(' '));
      poly.setAttribute('fill', a.color || '#7fa650');
      poly.setAttribute('opacity', a.opacity || 0.8);
      this.svg.append(poly);
    }
  }

  // ------------------------------------------------------------ interaction
  canMove(sq) {
    const p = this.pieces.get(sq);
    if (!p || !this.opts.interactive) return false;
    if (p.code[0] !== this.chess.turn()) return false;
    return this.opts.movable === 'both' || this.opts.movable === p.code[0];
  }
  select(sq) {
    this.selected = sq;
    const moves = this.chess.moves({ square: sq, verbose: true });
    this.targets = [...new Set(moves.map(m => m.to))];
    this.paintTargets();
    this.updateMarks({});
  }
  clearSelection() {
    this.selected = null; this.targets = [];
    this.paintTargets();
    if (this.sqEls) this.updateMarks({});
  }
  paintTargets() {
    for (const [sq, el] of Object.entries(this.sqEls)) {
      el.querySelector('.dot')?.remove();
      if (this.targets.includes(sq)) el.append(h('div.dot' + (this.pieces.has(sq) ? '.cap' : '')));
    }
  }
  onDown(e) {
    if (!this.opts.interactive || e.button === 2) return;
    if (this.promoEl) { this.promoEl.remove(); this.promoEl = null; this.clearSelection(); return; }
    const sq = this.sqFromEvent(e);
    if (!sq) return;
    if (this.selected && this.targets.includes(sq)) { this.tryMove(this.selected, sq); return; }
    if (!this.canMove(sq)) { this.clearSelection(); return; }
    this.select(sq);
    // drag
    const p = this.pieces.get(sq);
    const el = p.el;
    const rect = this.root.getBoundingClientRect();
    el.classList.add('dragging');
    const move = ev => {
      el.style.left = ((ev.clientX - rect.left) / rect.width * 100 - 6.25) + '%';
      el.style.top = ((ev.clientY - rect.top) / rect.height * 100 - 6.25) + '%';
    };
    move(e);
    const up = ev => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.classList.remove('dragging');
      this.place(el, sq);
      const to = this.sqFromEvent(ev);
      if (to && to !== sq && this.targets.includes(to)) this.tryMove(sq, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  tryMove(from, to) {
    const cands = this.chess.moves({ square: from, verbose: true }).filter(m => m.to === to);
    if (!cands.length) return;
    if (cands.length > 1) { this.askPromotion(from, to, cands); return; }
    this.emit(cands[0]);
  }
  emit(m) {
    this.clearSelection();
    const info = { from: m.from, to: m.to, promotion: m.promotion, uci: m.from + m.to + (m.promotion || ''), san: m.san, captured: !!m.captured };
    this.opts.onMove && this.opts.onMove(info);
  }
  askPromotion(from, to, cands) {
    const color = this.chess.turn();
    const [x, y] = this.xy(to);
    const down = y === 0;
    const box = h('div.promo');
    box.style.left = x * 12.5 + '%';
    box.style.top = (down ? 0 : 50) + '%';
    box.style.flexDirection = down ? 'column' : 'column-reverse';
    for (const t of ['Q', 'N', 'R', 'B']) {
      const b = h('div.promo-piece', { onpointerdown: ev => { ev.stopPropagation(); box.remove(); this.promoEl = null; this.emit(cands.find(c => c.promotion === t.toLowerCase())); } });
      b.style.backgroundImage = `url(pieces/${color}${t}.svg)`;
      box.append(b);
    }
    this.promoEl = box;
    this.root.append(box);
  }
  destroy() { this.root.remove(); }
}
