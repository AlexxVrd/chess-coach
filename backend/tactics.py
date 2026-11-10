"""Rated tactics trainer on the lichess puzzle database (data/lichess_puzzles.db, built by tools/import_lichess_puzzles.py).

The user gets an Elo-like tactics rating, puzzles near that rating, per-theme statistics (to find pattern weaknesses)
and a spaced-repetition queue for puzzles that were failed."""
import json
import random
import sqlite3
import threading
import time
from datetime import date, datetime

from . import db

PDB_PATH = db.DATA / "lichess_puzzles.db"
_local = threading.local()

THEMES_FR = {
    "mateIn1": "Mat en 1", "mateIn2": "Mat en 2", "mateIn3": "Mat en 3", "mateIn4": "Mat en 4", "mateIn5": "Mat en 5",
    "mate": "Mat", "fork": "Fourchette", "pin": "Clouage", "skewer": "Rayon X", "discoveredAttack": "Attaque à la découverte",
    "discoveredCheck": "Échec à la découverte", "doubleCheck": "Double échec", "hangingPiece": "Pièce en prise",
    "sacrifice": "Sacrifice", "deflection": "Déviation", "attraction": "Attraction", "interference": "Interférence",
    "clearance": "Dégagement", "intermezzo": "Coup intermédiaire", "quietMove": "Coup calme", "defensiveMove": "Coup défensif",
    "trappedPiece": "Pièce piégée", "exposedKing": "Roi exposé", "kingsideAttack": "Attaque côté roi",
    "queensideAttack": "Attaque côté dame", "backRankMate": "Mat du couloir", "smotheredMate": "Mat étouffé",
    "promotion": "Promotion", "advancedPawn": "Pion avancé", "endgame": "Finale", "rookEndgame": "Finale de tours",
    "pawnEndgame": "Finale de pions", "bishopEndgame": "Finale de fous", "knightEndgame": "Finale de cavaliers",
    "queenEndgame": "Finale de dames", "middlegame": "Milieu de partie", "opening": "Ouverture", "zugzwang": "Zugzwang",
    "capturingDefender": "Capture du défenseur", "xRayAttack": "Rayon X (x-ray)", "equality": "Égalisation",
    "advantage": "Avantage", "crushing": "Gain décisif", "winMaterial": "Gain de matériel",
}
# themes worth offering as training filters, in the order shown to the user
FILTER_THEMES = ["mateIn1", "mateIn2", "mateIn3", "fork", "pin", "skewer", "discoveredAttack", "hangingPiece", "sacrifice",
                 "deflection", "attraction", "quietMove", "defensiveMove", "trappedPiece", "backRankMate", "advancedPawn",
                 "promotion", "kingsideAttack", "exposedKing", "intermezzo", "clearance", "interference", "capturingDefender",
                 "endgame", "rookEndgame", "pawnEndgame", "zugzwang"]
HIDE = {"short", "long", "veryLong", "oneMove", "master", "masterVsMaster", "superGM", "crushing", "advantage", "equality", "mate", "opening", "middlegame"}


def available() -> bool:
    return PDB_PATH.exists() and PDB_PATH.stat().st_size > 1_000_000


def pdb():
    c = getattr(_local, "c", None)
    if c is None:
        c = sqlite3.connect(f"file:{PDB_PATH}?mode=ro", uri=True, timeout=30)
        c.row_factory = sqlite3.Row
        _local.c = c
    return c


def user_rating() -> float:
    return float(db.get_settings().get("tactics_rating", 1300))


def _midnight() -> int:
    return int(datetime.combine(date.today(), datetime.min.time()).timestamp())


def public(row) -> dict:
    themes = [t for t in row["themes"].split() if t not in HIDE]
    return {"id": row["id"], "fen": row["fen"], "moves": row["moves"].split(), "rating": row["rating"], "themes": themes,
            "plays": row["plays"]}


def next_puzzle(mode="rated", theme=None, exclude=None):
    """mode: rated (around the user's rating), theme (a pattern), review (failed puzzles due), random-hard (+150)."""
    if not available():
        return None
    now = int(time.time())
    if mode == "review":
        r = db.q1("SELECT * FROM tactic_srs WHERE due_at<=? ORDER BY due_at LIMIT 1", (now,))
        if not r:
            return None
        p = {"id": r["puzzle_id"], "fen": r["fen"], "moves": r["moves"].split(), "rating": r["rating"],
             "themes": [t for t in (r["themes"] or "").split() if t not in HIDE], "plays": 0}
        p["review"] = True
        return p
    rating = user_rating()
    seen = {r["puzzle_id"] for r in db.q("SELECT DISTINCT puzzle_id FROM tactic_attempts")}
    if exclude:
        seen.add(exclude)
    shift = 120 if mode == "hard" else 0
    long_only = mode == "calc"
    if long_only:
        shift = -150          # le calcul de longues lignes est plus dur : on part plus bas
    # nombre de demi-coups >= 8 (1 coup adverse + au moins 4 coups à toi avec réponses)
    cond = " AND (length(moves) - length(replace(moves,' ','')))>=7" if long_only else ""
    for width in (90, 160, 280, 500):
        lo, hi = int(rating + shift - width), int(rating + shift + width)
        if theme:
            rows = pdb().execute("""SELECT p.* FROM puzzle_theme t JOIN puzzles p ON p.id=t.id
                                    WHERE t.theme=? AND t.rating BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 40""".replace("ORDER BY", cond.replace("moves", "p.moves") + " ORDER BY"), (theme, lo, hi)).fetchall()
        else:
            rows = pdb().execute("SELECT * FROM puzzles WHERE rating BETWEEN ? AND ?" + cond + " ORDER BY RANDOM() LIMIT 40", (lo, hi)).fetchall()
        rows = [r for r in rows if r["id"] not in seen]
        if rows:
            return public(random.choice(rows))
    return None


def record(puzzle_id: str, outcome: str, time_ms: int = 0, hints: int = 0, mode: str = "rated"):
    """outcome: 'clean' (first try, no hint), 'assisted' (solved after a mistake or hint), 'failed' (gave up / skipped)."""
    row = pdb().execute("SELECT * FROM puzzles WHERE id=?", (puzzle_id,)).fetchone() if available() else None
    prev = db.q1("SELECT * FROM tactic_srs WHERE puzzle_id=?", (puzzle_id,))
    if row is None and prev:
        row = {"id": puzzle_id, "fen": prev["fen"], "moves": prev["moves"], "rating": prev["rating"], "themes": prev["themes"] or ""}
    if row is None:
        raise ValueError("puzzle inconnu")
    pr = row["rating"]
    ur = user_rating()
    n = db.q1("SELECT COUNT(*) n FROM tactic_attempts")["n"]
    score = {"clean": 1.0, "assisted": 0.35, "failed": 0.0}[outcome]
    # re-visiting a puzzle already attempted must not inflate the rating
    first_time = not db.q1("SELECT 1 x FROM tactic_attempts WHERE puzzle_id=?", (puzzle_id,))
    new = ur
    if first_time and mode != "review":
        k = 40 if n < 30 else 28 if n < 120 else 20
        exp = 1 / (1 + 10 ** ((pr - ur) / 400))
        new = max(400, ur + k * (score - exp))
        db.set_settings({"tactics_rating": round(new, 1)})
    now = int(time.time())
    themes = " ".join(t for t in row["themes"].split() if t not in HIDE) if isinstance(row["themes"], str) else ""
    db.run("""INSERT INTO tactic_attempts(puzzle_id, ts, correct, time_ms, hints, puzzle_rating, rating_before, rating_after, themes, mode)
              VALUES(?,?,?,?,?,?,?,?,?,?)""", (puzzle_id, now, 1 if outcome == "clean" else 0, time_ms, hints, pr, ur, new, themes, mode))
    # spaced repetition for puzzles that were not solved cleanly
    from .training import srs_next
    if outcome == "clean" and not prev:
        pass
    else:
        card = prev or {"reps": 0, "interval_days": 0, "ease": 2.3, "lapses": 0}
        s = srs_next(card, outcome == "clean")
        if outcome == "clean" and prev and prev["reps"] >= 3:
            db.run("DELETE FROM tactic_srs WHERE puzzle_id=?", (puzzle_id,))
        else:
            if outcome != "clean":
                s["due_at"] = now + 86400          # failed tactics come back tomorrow
            db.run("""INSERT INTO tactic_srs(puzzle_id, fen, moves, rating, themes, due_at, interval_days, ease, reps, lapses)
                      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(puzzle_id) DO UPDATE SET due_at=?, interval_days=?, ease=?, reps=?, lapses=?""",
                   (puzzle_id, row["fen"], row["moves"], pr, themes, s["due_at"], s["interval_days"], s["ease"], s["reps"], s["lapses"],
                    s["due_at"], s["interval_days"], s["ease"], s["reps"], s["lapses"]))
    return {"rating": round(new), "delta": round(new - ur, 1), "puzzle_rating": pr}


def stats():
    now = int(time.time())
    mid = _midnight()
    att = db.q("SELECT * FROM tactic_attempts ORDER BY ts DESC LIMIT 600")
    today = [a for a in att if a["ts"] >= mid]
    by = {}
    for a in att:
        for t in (a["themes"] or "").split():
            d = by.setdefault(t, {"n": 0, "clean": 0})
            d["n"] += 1
            d["clean"] += a["correct"]
    themes = sorted(({"theme": t, "label": THEMES_FR.get(t, t), "n": v["n"], "pct": round(100 * v["clean"] / v["n"])}
                     for t, v in by.items() if v["n"] >= 4), key=lambda x: x["pct"])
    hist = db.q("SELECT ts, rating_after FROM tactic_attempts ORDER BY ts DESC LIMIT 300")[::-1]
    last7 = [a for a in att if a["ts"] >= now - 7 * 86400]
    return {
        "available": available(), "rating": round(user_rating()),
        "today": len(today), "today_clean": sum(a["correct"] for a in today),
        "week": len(last7), "week_pct": round(100 * sum(a["correct"] for a in last7) / len(last7)) if last7 else None,
        "total": db.q1("SELECT COUNT(*) n FROM tactic_attempts")["n"],
        "due": db.q1("SELECT COUNT(*) n FROM tactic_srs WHERE due_at<=?", (now,))["n"],
        "themes": themes, "history": [[h["ts"], round(h["rating_after"])] for h in hist],
        "avg_time_s": round(sum(a["time_ms"] for a in today) / max(1, len(today)) / 1000, 1) if today else None,
    }


def theme_list():
    out = []
    for t in FILTER_THEMES:
        out.append({"theme": t, "label": THEMES_FR.get(t, t)})
    return out
