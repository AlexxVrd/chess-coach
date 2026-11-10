async function req(method, url, body) {
  const r = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const qs = o => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o || {})) if (v !== undefined && v !== null && v !== '' && v !== 'all') p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

export const api = {
  status: () => req('GET', '/api/status'),
  settings: () => req('GET', '/api/settings'),
  saveSettings: s => req('POST', '/api/settings', s),
  startImport: months => req('POST', '/api/import', { months }),
  autoImport: () => req('POST', '/api/import/auto'),
  importPgn: text => req('POST', '/api/import/pgn', { text }),
  games: f => req('GET', '/api/games' + qs(f)),
  game: id => req('GET', `/api/games/${id}`),
  gameMeta: (id, b) => req('POST', `/api/games/${id}/meta`, b),
  deleteGame: id => req('DELETE', `/api/games/${id}`),
  analyze: b => req('POST', '/api/analyze', b || {}),
  cancelAnalyze: () => req('POST', '/api/analyze/cancel'),
  overview: f => req('GET', '/api/stats/overview' + qs(f)),
  openings: f => req('GET', '/api/openings' + qs(f)),
  explorer: f => req('GET', '/api/explorer' + qs(f)),
  leaks: f => req('GET', '/api/leaks' + qs(f)),
  fenInfo: fen => req('GET', '/api/fenkey' + qs({ fen })),
  puzzleStats: () => req('GET', '/api/puzzles/stats'),
  puzzleNext: f => req('GET', '/api/puzzles/next' + qs(f)),
  puzzleAttempt: (id, uci, time_ms, record = true) => req('POST', `/api/puzzles/${id}/attempt`, { uci, time_ms, record }),
  puzzleStep: (id, fen, uci, step) => req('POST', `/api/puzzles/${id}/step`, { fen, uci, step }),
  puzzleFinish: (id, outcome, time_ms, hints) => req('POST', `/api/puzzles/${id}/finish`, { outcome, time_ms, hints }),
  tacticsStats: () => req('GET', '/api/tactics/stats'),
  tacticsThemes: () => req('GET', '/api/tactics/themes'),
  tacticsNext: f => req('GET', '/api/tactics/next' + qs(f)),
  tacticsResult: (id, outcome, time_ms, hints, mode) => req('POST', `/api/tactics/${id}/result`, { outcome, time_ms, hints, mode }),
  today: () => req('GET', '/api/today'),
  dailyLog: kind => req('POST', '/api/daily/log', { kind }),
  puzzleHint: id => req('GET', `/api/puzzles/${id}/hint`),
  puzzleGiveUp: id => req('POST', `/api/puzzles/${id}/giveup`),
  checkMove: (fen, uci) => req('POST', '/api/check_move', { fen, uci }),
  bestMove: fen => req('POST', '/api/bestmove', { fen }),
  play: (fen, elo, movetime) => req('POST', '/api/play', { fen, elo, movetime }),
  endgames: () => req('GET', '/api/endgames'),
  endgameResult: (id, success) => req('POST', `/api/endgames/${id}/result`, { success }),
  habits: f => req('GET', '/api/habits' + qs(f)),
  sparringPosition: (kind, exclude) => req('GET', '/api/sparring/position' + qs({ kind, exclude })),
  repertoires: () => req('GET', '/api/repertoires'),
  repertoire: id => req('GET', `/api/repertoires/${id}`),
  repLine: (id, f) => req('GET', `/api/repertoires/${id}/line` + qs(f)),
  repReview: (id, fenkey, correct) => req('POST', `/api/repertoires/${id}/review`, { fenkey, correct }),
};

/** Live engine over websocket. */
export class LiveEngine {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.ws = null; this.pending = null; this.enabled = true;
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws/analyze`);
    this.ws.onopen = () => { if (this.pending) this.ws.send(JSON.stringify(this.pending)); };
    this.ws.onmessage = e => this.onUpdate(JSON.parse(e.data));
    this.ws.onclose = () => { this.ws = null; };
  }
  analyze(fen, multipv = 3) {
    this.pending = { fen, multipv };
    if (!this.enabled) return;
    if (!this.ws) this.connect();
    else if (this.ws.readyState === 1) this.ws.send(JSON.stringify(this.pending));
  }
  stop() { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ stop: true })); }
  setEnabled(v) { this.enabled = v; if (!v) this.stop(); else if (this.pending) this.analyze(this.pending.fen, this.pending.multipv); }
  close() { try { this.ws && this.ws.close(); } catch { /* ignore */ } this.ws = null; }
}
