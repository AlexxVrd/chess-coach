"""SQLite storage (single local file)."""
import json
import os
import sqlite3
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
DB_DIR = Path(os.environ.get("CC_DATA_DIR", DATA))
DB_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DB_DIR / "chesscoach.db"

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT, ext_id TEXT UNIQUE, url TEXT,
  white TEXT, black TEXT, white_elo INTEGER, black_elo INTEGER,
  result TEXT, termination TEXT,
  time_control TEXT, time_class TEXT, rated INTEGER DEFAULT 1,
  played_at INTEGER, pgn TEXT,
  user_color TEXT, user_result TEXT, user_elo INTEGER, opp_elo INTEGER,
  eco TEXT, opening TEXT, book_plies INTEGER DEFAULT 0, plies INTEGER DEFAULT 0,
  analyzed INTEGER DEFAULT 0, analysis_depth INTEGER,
  acc_white REAL, acc_black REAL, acpl_white REAL, acpl_black REAL,
  notes TEXT DEFAULT '', starred INTEGER DEFAULT 0, reviewed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_games_played ON games(played_at);

CREATE TABLE IF NOT EXISTS moves (
  game_id INTEGER, ply INTEGER,
  color TEXT, san TEXT, uci TEXT, fen_before TEXT, fenkey TEXT,
  eval_before INTEGER, eval_after INTEGER,   -- centipawns, white point of view (mate = +-10000-ish)
  mate_before INTEGER, mate_after INTEGER,
  best_uci TEXT, best_san TEXT, second_uci TEXT, second_eval INTEGER,
  pv TEXT, pv_san TEXT,
  loss REAL, accuracy REAL, cls TEXT, phase TEXT, is_book INTEGER DEFAULT 0,
  clock_ms INTEGER, spent_ms INTEGER, tags TEXT DEFAULT '[]',
  PRIMARY KEY (game_id, ply)
);
CREATE INDEX IF NOT EXISTS idx_moves_fenkey ON moves(fenkey);
CREATE INDEX IF NOT EXISTS idx_moves_cls ON moves(cls);

CREATE TABLE IF NOT EXISTS evals (
  fenkey TEXT, depth INTEGER, lines TEXT,
  PRIMARY KEY (fenkey)
);

CREATE TABLE IF NOT EXISTS puzzles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER, ply INTEGER,
  fen TEXT UNIQUE, side TEXT,
  solution_uci TEXT, solution_san TEXT, pv_san TEXT,
  played_uci TEXT, played_san TEXT,
  loss REAL, eval_before INTEGER, tags TEXT DEFAULT '[]', phase TEXT,
  due_at INTEGER DEFAULT 0, interval_days REAL DEFAULT 0, ease REAL DEFAULT 2.3,
  reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, last_result INTEGER,
  created_at INTEGER, suspended INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS puzzle_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_id INTEGER, ts INTEGER, correct INTEGER, time_ms INTEGER
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS rep_progress (
  rep_id TEXT, fenkey TEXT,
  due_at INTEGER DEFAULT 0, interval_days REAL DEFAULT 0, ease REAL DEFAULT 2.3,
  reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, last_ts INTEGER,
  PRIMARY KEY (rep_id, fenkey)
);

CREATE TABLE IF NOT EXISTS move_evals (
  fenkey TEXT, uci TEXT, depth INTEGER, cp INTEGER, mate INTEGER, pv TEXT,
  PRIMARY KEY (fenkey, uci)
);

-- rated tactics (lichess puzzle database) progress
CREATE TABLE IF NOT EXISTS tactic_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  puzzle_id TEXT, ts INTEGER, correct INTEGER, time_ms INTEGER, hints INTEGER DEFAULT 0,
  puzzle_rating INTEGER, rating_before REAL, rating_after REAL, themes TEXT, mode TEXT
);
CREATE INDEX IF NOT EXISTS idx_tactic_att_pid ON tactic_attempts(puzzle_id);
CREATE INDEX IF NOT EXISTS idx_tactic_att_ts ON tactic_attempts(ts);
CREATE TABLE IF NOT EXISTS tactic_srs (
  puzzle_id TEXT PRIMARY KEY, fen TEXT, moves TEXT, rating INTEGER, themes TEXT,
  due_at INTEGER DEFAULT 0, interval_days REAL DEFAULT 0, ease REAL DEFAULT 2.3, reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_log (
  day TEXT, kind TEXT, n INTEGER DEFAULT 0, PRIMARY KEY (day, kind)
);

CREATE TABLE IF NOT EXISTS endgame_progress (
  drill_id TEXT PRIMARY KEY, attempts INTEGER DEFAULT 0, successes INTEGER DEFAULT 0, last_ts INTEGER
);
"""


def conn() -> sqlite3.Connection:
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.c = c
    return c


MIGRATIONS = {
    "games": {"analysis_version": "INTEGER DEFAULT 1", "guided_done": "INTEGER DEFAULT 0"},
    "moves": {"verified": "INTEGER DEFAULT 0", "depth": "INTEGER", "refut_san": "TEXT", "gap": "REAL", "second_san": "TEXT",
              "played_cp": "INTEGER"},
    "puzzles": {"kind": "TEXT", "themes": "TEXT DEFAULT '[]'", "gap": "REAL", "solution_pv": "TEXT", "refut_san": "TEXT",
                "mate_in": "INTEGER", "attempts": "INTEGER DEFAULT 0", "solved_first": "INTEGER DEFAULT 0"},
}


def init():
    c = conn()
    c.executescript(SCHEMA)
    for table, cols in MIGRATIONS.items():
        have = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
        for col, decl in cols.items():
            if col not in have:
                c.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
    c.commit()


def q(sql, args=()):
    return [dict(r) for r in conn().execute(sql, args).fetchall()]


def q1(sql, args=()):
    r = conn().execute(sql, args).fetchone()
    return dict(r) if r else None


def run(sql, args=()):
    c = conn()
    cur = c.execute(sql, args)
    c.commit()
    return cur


DEFAULT_SETTINGS = {
    "chesscom_user": "",
    "lichess_user": "",
    "depth": 18,
    "quality": "balanced",
    "tactics_rating": 1300,
    "daily_goal_puzzles": 10,
    "daily_goal_tactics": 15,
    "target_rating": 2000,
    "threads": 8,
    "hash_mb": 64,
    "pause_on_battery": True,
    "board_theme": "green",
    "sound": True,
    "auto_analyze": True,
    "auto_import": True,
    "import_months": 6,
}


def get_settings() -> dict:
    s = dict(DEFAULT_SETTINGS)
    for r in q("SELECT key, value FROM settings"):
        try:
            s[r["key"]] = json.loads(r["value"])
        except Exception:
            s[r["key"]] = r["value"]
    return s


def set_settings(d: dict):
    c = conn()
    for k, v in d.items():
        if k in DEFAULT_SETTINGS:
            c.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", (k, json.dumps(v)))
    c.commit()
