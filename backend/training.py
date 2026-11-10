"""Puzzle trainer (spaced repetition on the user's own mistakes), move checking, play-vs-engine, endgame drills."""
import json
import threading
import time
from datetime import date, datetime, timedelta

import chess
import chess.engine

from . import analyzer, db
from .analyzer import Engine, winprob, san_line

_util = None
_util_lock = threading.Lock()
_play = None
_play_lock = threading.Lock()


def util_engine() -> Engine:
    global _util
    with _util_lock:
        if _util is None:
            _util = Engine(2, 128)
        return _util


def shutdown():
    global _util, _play
    if _util:
        _util.close()
        _util = None
    if _play:
        try:
            _play.quit()
        except Exception:
            pass
        _play = None


# ------------------------------------------------------------------ move evaluation
def evaluate_move(fen: str, uci: str, depth: int = 16):
    """Compare a move to the engine's best. Returns loss in win% points plus best move and refutation line."""
    board = chess.Board(fen)
    move = chess.Move.from_uci(uci)
    if move not in board.legal_moves:
        raise ValueError("coup illégal")
    eng = util_engine()
    sign = 1 if board.turn == chess.WHITE else -1
    lines = eng.lines(board, depth, 2)
    best = lines[0]
    best_uci = best["pv"][0] if best["pv"] else uci
    best_move = chess.Move.from_uci(best_uci)
    san = board.san(move)
    best_san = board.san(best_move) if best_move in board.legal_moves else best_uci
    after = board.copy(stack=False)
    after.push(move)
    child = analyzer.terminal_line(after) if after.is_game_over() else eng.lines(after, depth, 1)
    cp_after = child[0]["cp"]
    for l in lines:
        if l["pv"] and l["pv"][0] == uci:
            cp_after = l["cp"]
    loss = 0.0 if uci == best_uci else max(0.0, winprob(sign * best["cp"]) - winprob(sign * cp_after))
    mate_ok = best["mate"] is not None and best["mate"] * sign > 0 and child[0]["mate"] is not None and child[0]["mate"] * sign > 0
    return {
        "uci": uci, "san": san, "best_uci": best_uci, "best_san": best_san,
        "loss": round(loss, 1), "eval_best": best["cp"], "eval_played": cp_after,
        "mate_best": best["mate"], "mate_played": child[0]["mate"],
        "best_line": san_line(board, best["pv"], 6),
        "refutation": san_line(after, child[0]["pv"], 5) if not after.is_game_over() else "",
        "ok": uci == best_uci or loss <= 3.0 or (mate_ok and loss <= 8),
        "exact": uci == best_uci,
    }


# ------------------------------------------------------------------ puzzles / SRS
def _tags(p):
    p["tags"] = json.loads(p["tags"] or "[]")
    return p


def pick_next(mode="due", tag=None, phase=None, exclude=None, theme=None):
    now = int(time.time())
    w, a = ["suspended=0"], []
    if mode == "due":
        w.append("due_at<=? AND reps>0")
        a.append(now)
    elif mode == "new":
        w.append("reps=0 AND lapses=0")
    elif mode == "failed":
        w.append("lapses>0")
    if tag:
        w.append("tags LIKE ?")
        a.append(f'%"{tag}"%')
    if theme:
        w.append("themes LIKE ?")
        a.append(f'%"{theme}"%')
    if phase:
        w.append("phase=?")
        a.append(phase)
    if exclude:
        w.append("id<>?")
        a.append(int(exclude))
    order = "due_at ASC, loss DESC" if mode == "due" else "loss DESC, created_at DESC" if mode == "new" else "RANDOM()"
    p = db.q1(f"SELECT * FROM puzzles WHERE {' AND '.join(w)} ORDER BY {order} LIMIT 1", a)
    return _tags(p) if p else None


def puzzle_for_client(p, reveal=False):
    out = {k: p[k] for k in ("id", "fen", "side", "game_id", "ply", "phase", "tags", "loss", "reps", "lapses", "interval_days")}
    out["themes"] = json.loads(p.get("themes") or "[]")
    out["mate_in"] = p.get("mate_in")
    out["solution_pv"] = (p.get("solution_pv") or "").split()
    out["hint_from"] = (p.get("solution_uci") or "")[:2]
    out["hint_to"] = (p.get("solution_uci") or "")[2:4]
    out["solution_uci"] = p.get("solution_uci")
    out["solution_san"] = p.get("solution_san")
    out["pv_san"] = p.get("pv_san")
    out["played_san"] = p.get("played_san")
    out["refut_san"] = p.get("refut_san")
    if reveal:
        out.update({k: p[k] for k in ("solution_uci", "solution_san", "pv_san", "played_uci", "played_san")})
    return out


def srs_next(card, correct: bool) -> dict:
    """SM-2 style schedule shared by puzzles and repertoire positions. `card` needs reps, interval_days, ease, lapses."""
    now = int(time.time())
    reps, interval, ease, lapses = card["reps"], card["interval_days"], card["ease"], card["lapses"]
    if correct:
        reps += 1
        interval = 1 if reps == 1 else 3 if reps == 2 else max(interval * ease, 4)
        ease = min(2.8, ease + 0.05)
        due = now + int(interval * 86400)
    else:
        lapses += 1
        reps = 0
        interval = 0
        ease = max(1.3, ease - 0.2)
        due = now + 600
    return {"reps": reps, "interval_days": interval, "ease": ease, "lapses": lapses, "due_at": due}


def srs_update(p, correct: bool):
    s = srs_next(p, correct)
    db.run("UPDATE puzzles SET reps=?, interval_days=?, ease=?, lapses=?, due_at=?, last_result=? WHERE id=?",
           (s["reps"], s["interval_days"], s["ease"], s["lapses"], s["due_at"], 1 if correct else 0, p["id"]))
    return {"next_due_days": round(s["interval_days"], 1), "reps": s["reps"]}


def attempt(pid: int, uci: str, time_ms: int = 0, record: bool = True):
    p = db.q1("SELECT * FROM puzzles WHERE id=?", (pid,))
    if not p:
        raise ValueError("puzzle introuvable")
    ev = evaluate_move(p["fen"], uci, 16)
    # stored analysis (deeper) can promote an alternative as acceptable
    correct = ev["ok"]
    res = {"correct": correct, "exact": ev["exact"], "alt": correct and not ev["exact"], "eval": ev,
           "solution_san": p["solution_san"], "solution_uci": p["solution_uci"], "pv_san": p["pv_san"],
           "played_in_game": p["played_san"]}
    if record:
        db.run("INSERT INTO puzzle_attempts(puzzle_id, ts, correct, time_ms) VALUES(?,?,?,?)", (pid, int(time.time()), 1 if correct else 0, time_ms))
        res["srs"] = srs_update(p, correct)
    return res


def check_step(pid: int, fen: str, uci: str, step: int = 0):
    """Evaluate one move of a (possibly multi-move) puzzle from any position of its line.

    Returns the evaluation of the move and, when the move is right and the tactic is not over, the opponent's reply."""
    p = db.q1("SELECT * FROM puzzles WHERE id=?", (pid,))
    if not p:
        raise ValueError("puzzle introuvable")
    ev = evaluate_move(fen, uci, 16)
    res = {"correct": ev["ok"], "exact": ev["exact"], "eval": ev, "done": False, "reply": None, "step": step,
           "solution_san": p["solution_san"], "pv_san": p["pv_san"]}
    if not ev["ok"]:
        return res
    board = chess.Board(fen)
    mover = board.turn
    board.push(chess.Move.from_uci(uci))
    if board.is_game_over():
        res["done"] = True
        res["result"] = "mate" if board.is_checkmate() else "draw"
        return res
    if step >= 2:
        res["done"] = True
        return res
    eng = util_engine()
    sign = 1 if mover == chess.WHITE else -1
    reply = eng.lines(board, 16, 1)[0]["pv"]
    if not reply:
        res["done"] = True
        return res
    b2 = board.copy(stack=False)
    b2.push(chess.Move.from_uci(reply[0]))
    if b2.is_game_over():
        res["done"] = True
        return res
    nxt = eng.lines(b2, 16, 2)
    mate_next = nxt[0]["mate"] is not None and 0 < nxt[0]["mate"] * sign <= 3
    gap = (winprob(sign * nxt[0]["cp"]) - winprob(sign * nxt[1]["cp"])) if len(nxt) > 1 else 0
    if mate_next or gap >= 12:
        res["reply"] = reply[0]
        res["reply_san"] = board.san(chess.Move.from_uci(reply[0]))
        res["fen_after_reply"] = b2.fen()
    else:
        res["done"] = True
    return res


def finish(pid: int, outcome: str, time_ms: int = 0, hints: int = 0):
    """Called once when the user is done with a puzzle. outcome: clean | assisted | failed."""
    p = db.q1("SELECT * FROM puzzles WHERE id=?", (pid,))
    if not p:
        raise ValueError("puzzle introuvable")
    clean = outcome == "clean"
    db.run("INSERT INTO puzzle_attempts(puzzle_id, ts, correct, time_ms) VALUES(?,?,?,?)", (pid, int(time.time()), 1 if clean else 0, time_ms))
    s = srs_next(p, clean)
    if not clean:
        s["due_at"] = int(time.time()) + (3600 if outcome == "assisted" else 600)
    db.run("""UPDATE puzzles SET reps=?, interval_days=?, ease=?, lapses=?, due_at=?, last_result=?,
              attempts=COALESCE(attempts,0)+1, solved_first=COALESCE(solved_first,0)+? WHERE id=?""",
           (s["reps"], s["interval_days"], s["ease"], s["lapses"], s["due_at"], 1 if clean else 0, 1 if clean else 0, pid))
    return {"next_due_days": round(s["interval_days"], 1) if clean else 0, "reps": s["reps"]}


def give_up(pid: int):
    p = db.q1("SELECT * FROM puzzles WHERE id=?", (pid,))
    db.run("INSERT INTO puzzle_attempts(puzzle_id, ts, correct, time_ms) VALUES(?,?,0,0)", (pid, int(time.time())))
    srs = srs_update(p, False)
    return {"solution_san": p["solution_san"], "solution_uci": p["solution_uci"], "pv_san": p["pv_san"], "srs": srs}


def puzzle_stats():
    now = int(time.time())
    total = db.q1("SELECT COUNT(*) n FROM puzzles WHERE suspended=0")["n"]
    due = db.q1("SELECT COUNT(*) n FROM puzzles WHERE suspended=0 AND reps>0 AND due_at<=?", (now,))["n"]
    new = db.q1("SELECT COUNT(*) n FROM puzzles WHERE suspended=0 AND reps=0 AND lapses=0")["n"]
    learned = db.q1("SELECT COUNT(*) n FROM puzzles WHERE interval_days>=21")["n"]
    week = db.q1("SELECT COUNT(*) n, COALESCE(SUM(correct),0) c FROM puzzle_attempts WHERE ts>=?", (now - 7 * 86400,))
    midnight = int(datetime.combine(date.today(), datetime.min.time()).timestamp())   # local time, not UTC
    today = db.q1("SELECT COUNT(*) n FROM puzzle_attempts WHERE ts>=?", (midnight,))["n"]
    by_tag = {}
    for p in db.q("SELECT tags, lapses, reps FROM puzzles"):
        for t in json.loads(p["tags"] or "[]"):
            d = by_tag.setdefault(t, {"n": 0, "lapses": 0})
            d["n"] += 1
            d["lapses"] += p["lapses"]
    # daily streak
    days = {date.fromtimestamp(r["ts"]) for r in db.q("SELECT ts FROM puzzle_attempts")}
    cur = date.today()
    if cur not in days:      # streak still alive if the last session was yesterday
        cur -= timedelta(days=1)
    streak = 0
    while cur in days:
        streak += 1
        cur -= timedelta(days=1)
    theme_stats = {}
    for p in db.q("SELECT themes, lapses, reps FROM puzzles WHERE kind='own'"):
        for t in json.loads(p["themes"] or "[]"):
            d = theme_stats.setdefault(t, {"n": 0, "lapses": 0})
            d["n"] += 1
            d["lapses"] += p["lapses"]
    return {"theme_stats": theme_stats, "total": total, "due": due, "new": new, "learned": learned, "week_attempts": week["n"],
            "week_success": round(100 * week["c"] / week["n"], 1) if week["n"] else None, "today": today,
            "by_tag": by_tag, "streak": streak}


# ------------------------------------------------------------------ play vs engine
def play_move(fen: str, elo: int = 1600, movetime_ms: int = 600):
    global _play
    board = chess.Board(fen)
    with _play_lock:
        if _play is None:
            _play = chess.engine.SimpleEngine.popen_uci(analyzer.STOCKFISH)
            _play.configure({"Threads": 2, "Hash": 128})
        if elo >= 3190:
            _play.configure({"UCI_LimitStrength": False})
        else:
            _play.configure({"UCI_LimitStrength": True, "UCI_Elo": max(1320, min(3190, elo))})
        r = _play.play(board, chess.engine.Limit(time=movetime_ms / 1000))
    return {"uci": r.move.uci(), "san": board.san(r.move)}


# ------------------------------------------------------------------ endgame drills
# goal: "win" (side to move should win), "draw" (side to move must hold)
ENDGAMES = [
    {"id": "kq", "level": 1, "title": "Mat Dame + Roi", "goal": "win", "fen": "8/8/8/4k3/8/8/8/3QK3 w - - 0 1",
     "tip": "Rétrécis la boîte avec la dame à distance de cavalier, amène ton roi, et attention au pat."},
    {"id": "kr", "level": 1, "title": "Mat Tour + Roi", "goal": "win", "fen": "8/8/8/4k3/8/8/8/R3K3 w - - 0 1",
     "tip": "Méthode de la boîte : coupe le roi adverse avec la tour, avance ton roi, mat sur la bande."},
    {"id": "kpk_att", "level": 1, "title": "Roi + Pion : roi devant le pion (gagner)", "goal": "win", "fen": "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1",
     "tip": "Roi sur la 6e rangée devant le pion = gain. Prends l'opposition, ne pousse le pion qu'au bon moment."},
    {"id": "kpk_def", "level": 1, "title": "Roi + Pion : tenir la nulle (opposition)", "goal": "draw", "fen": "8/8/8/8/4k3/8/4P3/4K3 b - - 0 1",
     "tip": "Reste devant le pion et garde l'opposition ; le pat et la prise du pion sont tes armes."},
    {"id": "rvp", "level": 1, "title": "Tour contre pion", "goal": "win", "fen": "8/1R6/8/8/8/5p2/5k2/7K w - - 0 1",
     "tip": "Coupe le roi, attaque le pion par derrière, évite les pièges de pat."},
    {"id": "kbb", "level": 2, "title": "Mat deux Fous + Roi", "goal": "win", "fen": "8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1",
     "tip": "Les deux fous forment un mur diagonal ; pousse le roi vers un coin."},
    {"id": "lucena", "level": 2, "title": "Position de Lucena", "goal": "win", "fen": "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",
     "tip": "Construis le pont : amène la tour en 4e rangée (Td4) puis protège ton roi des échecs avec elle."},
    {"id": "philidor", "level": 2, "title": "Position de Philidor (tenir la nulle)", "goal": "draw", "fen": "4k3/8/r7/4PK2/8/8/8/7R b - - 0 1",
     "tip": "Garde la tour sur la 6e rangée tant que le pion n'a pas avancé, puis échecs par derrière."},
    {"id": "kqkr", "level": 3, "title": "Dame contre Tour", "goal": "win", "fen": "8/8/8/8/3k4/8/1r6/Q3K3 w - - 0 1",
     "tip": "Technique : fourchettes dame-roi/tour et rapprochement du roi. Très instructif."},
    {"id": "kbn", "level": 3, "title": "Mat Fou + Cavalier + Roi", "goal": "win", "fen": "8/8/8/4k3/8/8/8/2B1KN2 w - - 0 1",
     "tip": "Le mat se fait dans le coin de la couleur de ton fou (méthode du W)."},
    {"id": "kpk_key", "level": 1, "title": "Roi + Pion : le seul coup gagnant", "goal": "win", "fen": "8/8/8/2kP4/4K3/8/8/8 w - - 0 1",
     "tip": "Un seul coup gagne : pense aux cases clés (roi à 2 rangées devant le pion) avant de pousser."},
    {"id": "wrongb", "level": 2, "title": "Fou de la mauvaise couleur + pion a : tenir", "goal": "draw", "fen": "k7/8/8/8/8/8/P7/K1B5 b - - 0 1",
     "tip": "Le fou ne contrôle pas la case de promotion : va dans le coin a8 et ne le quitte pas, c'est nul."},
    {"id": "krkb", "level": 3, "title": "Tour contre Fou : tenir la nulle", "goal": "draw", "fen": "8/8/8/4k3/8/3b4/8/R3K3 b - - 0 1",
     "tip": "Avec le fou, garde ton roi près du fou, évite le bord, et ne te laisse pas fourcher."},
    {"id": "rvn", "level": 3, "title": "Tour contre Cavalier : gagner", "goal": "win", "fen": "8/8/8/8/3k4/8/3n4/R3K3 w - - 0 1",
     "tip": "Attaque le cavalier avec la tour en le séparant de son roi ; cherche les fourchettes à tour+roi."},
]


def endgames():
    prog = {r["drill_id"]: r for r in db.q("SELECT * FROM endgame_progress")}
    out = []
    for e in ENDGAMES:
        p = prog.get(e["id"], {})
        out.append({**e, "attempts": p.get("attempts", 0), "successes": p.get("successes", 0)})
    return out


def endgame_result(drill_id: str, success: bool):
    db.run("""INSERT INTO endgame_progress(drill_id, attempts, successes, last_ts) VALUES(?,1,?,?)
              ON CONFLICT(drill_id) DO UPDATE SET attempts=attempts+1, successes=successes+?, last_ts=?""",
           (drill_id, 1 if success else 0, int(time.time()), 1 if success else 0, int(time.time())))
