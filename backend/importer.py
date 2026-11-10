"""Game import: chess.com, lichess, raw PGN."""
import io
import json
import re
import time
from datetime import datetime, timezone

import chess.pgn
import httpx

from . import db, openings

UA = {"User-Agent": "ChessCoach-local/1.0 (personal analysis tool)"}

STATE = {"running": False, "message": "", "new": 0, "error": None}


def time_class_from_tc(tc: str) -> str:
    try:
        base, _, inc = tc.partition("+")
        est = int(base.split("/")[-1]) + 40 * int(inc or 0)
    except Exception:
        return "unknown"
    if est < 180:
        return "bullet"
    if est < 480:
        return "blitz"
    if est < 1500:
        return "rapid"
    return "classical"


def _parse_ts(h) -> int:
    d, t = h.get("UTCDate") or h.get("Date"), h.get("UTCTime") or "00:00:00"
    try:
        return int(datetime.strptime(f"{d} {t}", "%Y.%m.%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp())
    except Exception:
        return int(time.time())


def _int(v):
    try:
        return int(v)
    except Exception:
        return None


def my_names():
    s = db.get_settings()
    return {n.strip().lower() for n in (s.get("chesscom_user"), s.get("lichess_user")) if n and n.strip()}


def store_pgn(pgn_text: str, source: str, ext_id: str | None = None, url: str | None = None, meta: dict | None = None):
    """Parse one PGN and insert it. Returns game id, or None if skipped/duplicate."""
    meta = meta or {}
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return None
    h = game.headers
    if h.get("Variant", "Standard") not in ("Standard", "From Position") or "FEN" in h:
        return None
    moves = list(game.mainline_moves())
    if len(moves) < 2:
        return None
    ext_id = ext_id or url or f"{source}:{h.get('White')}:{h.get('Black')}:{h.get('UTCDate')}:{h.get('UTCTime')}"
    if db.q1("SELECT id FROM games WHERE ext_id=?", (ext_id,)):
        return None

    white, black = h.get("White", "?"), h.get("Black", "?")
    names = my_names()
    user_color = None
    if white.lower() in names:
        user_color = "w"
    elif black.lower() in names:
        user_color = "b"
    result = h.get("Result", "*")
    user_result = None
    if user_color and result in ("1-0", "0-1", "1/2-1/2"):
        if result == "1/2-1/2":
            user_result = "draw"
        elif (result == "1-0") == (user_color == "w"):
            user_result = "win"
        else:
            user_result = "loss"
    tc = h.get("TimeControl", "")
    tclass = meta.get("time_class") or time_class_from_tc(tc)
    we, be = _int(h.get("WhiteElo")), _int(h.get("BlackElo"))
    eco, oname, book_plies = openings.classify_game(game)
    played_at = meta.get("end_time") or _parse_ts(h)
    cur = db.run(
        """INSERT INTO games(source, ext_id, url, white, black, white_elo, black_elo, result, termination,
           time_control, time_class, rated, played_at, pgn, user_color, user_result, user_elo, opp_elo,
           eco, opening, book_plies, plies) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (source, ext_id, url or h.get("Link") or h.get("Site"), white, black, we, be, result,
         h.get("Termination", ""), tc, tclass, 1 if meta.get("rated", True) else 0, played_at, pgn_text,
         user_color, user_result,
         (we if user_color == "w" else be) if user_color else None,
         (be if user_color == "w" else we) if user_color else None,
         eco, oname, book_plies, len(moves)),
    )
    gid = cur.lastrowid
    # skeleton move rows so the opening explorer works before engine analysis
    b = game.board()
    rows = []
    for i, m in enumerate(moves):
        rows.append((gid, i + 1, "w" if b.turn else "b", b.san(m), m.uci(), b.fen(), openings.fenkey(b)))
        b.push(m)
    c = db.conn()
    c.executemany("INSERT INTO moves(game_id, ply, color, san, uci, fen_before, fenkey) VALUES(?,?,?,?,?,?,?)", rows)
    c.commit()
    return gid


def import_chesscom(username: str, months: int = 6):
    new = 0
    with httpx.Client(headers=UA, timeout=30, follow_redirects=True) as c:
        r = c.get(f"https://api.chess.com/pub/player/{username}/games/archives")
        if r.status_code == 404:
            raise RuntimeError(f"Utilisateur chess.com introuvable : {username}")
        r.raise_for_status()
        archives = r.json().get("archives", [])
        if months and months > 0:
            archives = archives[-months:]
        for i, a in enumerate(archives):
            STATE["message"] = f"chess.com : {a[-7:]} ({i + 1}/{len(archives)})"
            rr = c.get(a)
            if rr.status_code != 200:
                continue
            for g in rr.json().get("games", []):
                if g.get("rules") != "chess" or not g.get("pgn"):
                    continue
                gid = store_pgn(
                    g["pgn"], "chess.com", ext_id=g.get("url"), url=g.get("url"),
                    meta={"time_class": g.get("time_class"), "rated": g.get("rated", True), "end_time": g.get("end_time")},
                )
                if gid:
                    new += 1
                    STATE["new"] += 1
    return new


def import_lichess(username: str, months: int = 6):
    new = 0
    since = int((time.time() - (months or 120) * 30.5 * 86400) * 1000)
    params = {"since": since, "pgnInJson": "true", "clocks": "true", "opening": "false", "moves": "true"}
    headers = dict(UA, Accept="application/x-ndjson")
    with httpx.Client(headers=headers, timeout=None) as c:
        with c.stream("GET", f"https://lichess.org/api/games/user/{username}", params=params) as r:
            if r.status_code == 404:
                raise RuntimeError(f"Utilisateur lichess introuvable : {username}")
            r.raise_for_status()
            for line in r.iter_lines():
                if not line.strip():
                    continue
                g = json.loads(line)
                if g.get("variant") != "standard":
                    continue
                STATE["message"] = f"lichess : {new} nouvelles parties"
                gid = store_pgn(
                    g.get("pgn", ""), "lichess", ext_id=f"https://lichess.org/{g['id']}", url=f"https://lichess.org/{g['id']}",
                    meta={"time_class": g.get("speed"), "rated": g.get("rated", True),
                          "end_time": int(g.get("lastMoveAt", 0) / 1000) or None},
                )
                if gid:
                    new += 1
                    STATE["new"] += 1
    return new


def import_all(months: int | None = None):
    """Import for all configured accounts. Blocking; run in a thread."""
    if STATE["running"]:
        return
    s = db.get_settings()
    months = months if months is not None else int(s.get("import_months", 6))
    STATE.update(running=True, message="Démarrage…", new=0, error=None)
    try:
        if s.get("chesscom_user"):
            import_chesscom(s["chesscom_user"].strip(), months)
        if s.get("lichess_user"):
            import_lichess(s["lichess_user"].strip(), months)
        if not (s.get("chesscom_user") or s.get("lichess_user")):
            STATE["error"] = "Renseigne ton pseudo chess.com ou lichess dans les paramètres."
        # re-attribute colors for already stored games if usernames changed
        reattribute()
        STATE["message"] = f"Terminé : {STATE['new']} nouvelles parties"
    except Exception as e:  # noqa: BLE001
        STATE["error"] = str(e)
        STATE["message"] = "Erreur"
    finally:
        STATE["running"] = False


def reattribute():
    names = my_names()
    if not names:
        return
    for g in db.q("SELECT id, white, black, white_elo, black_elo, result FROM games WHERE user_color IS NULL"):
        col = "w" if g["white"].lower() in names else "b" if g["black"].lower() in names else None
        if not col:
            continue
        res = g["result"]
        ur = None
        if res == "1/2-1/2":
            ur = "draw"
        elif res in ("1-0", "0-1"):
            ur = "win" if (res == "1-0") == (col == "w") else "loss"
        db.run("UPDATE games SET user_color=?, user_result=?, user_elo=?, opp_elo=? WHERE id=?",
               (col, ur, g["white_elo"] if col == "w" else g["black_elo"],
                g["black_elo"] if col == "w" else g["white_elo"], g["id"]))


def import_pgn_text(text: str) -> int:
    n = 0
    stream = io.StringIO(text)
    while True:
        # find raw game text by re-reading with python-chess and re-exporting
        game = chess.pgn.read_game(stream)
        if game is None:
            break
        exporter = chess.pgn.StringExporter(headers=True, variations=False, comments=True)
        if store_pgn(game.accept(exporter), "pgn"):
            n += 1
    reattribute()
    return n
