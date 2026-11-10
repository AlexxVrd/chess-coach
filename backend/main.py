"""Chess Coach - local FastAPI server."""
import asyncio
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import chess
import chess.engine
from fastapi import Body, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import habits, sparring, analyzer, daily, db, importer, openings, repertoire, stats, tactics, training

ROOT = Path(__file__).resolve().parent.parent


@asynccontextmanager
async def lifespan(_app):
    db.init()
    threading.Thread(target=openings.load, daemon=True).start()
    if not maybe_auto_import():
        _auto_enqueue()   # games left unanalysed by a previous session (the import job does this itself)
    yield
    training.shutdown()


app = FastAPI(title="Chess Coach", lifespan=lifespan)

_last_auto = {"t": 0.0}


def maybe_auto_import(force=False):
    """Fetch recent games if accounts are configured (at most every 5 minutes)."""
    s = db.get_settings()
    if not s.get("auto_import", True) or not (s.get("chesscom_user") or s.get("lichess_user")):
        return False
    if importer.STATE["running"] or (not force and time.time() - _last_auto["t"] < 300):
        return False
    _last_auto["t"] = time.time()
    threading.Thread(target=_import_job, args=(2,), daemon=True).start()   # current + previous month
    return True


@app.post("/api/import/auto")
def auto_import():
    return {"started": maybe_auto_import()}


# ------------------------------------------------------------------ status / settings
@app.get("/api/status")
def status():
    return {
        "engine": analyzer.STOCKFISH,
        "games": db.q1("SELECT COUNT(*) n FROM games")["n"],
        "analyzed": db.q1("SELECT COUNT(*) n FROM games WHERE analyzed=1")["n"],
        "import": importer.STATE,
        "queue": {**{k: v for k, v in analyzer.Q.items() if k not in ("ids", "bgids")}, "pending": len(analyzer.Q["ids"]) + len(analyzer.Q["bgids"])},
        "settings": db.get_settings(),
        "book_loaded": openings._book is not None,
        "outdated": db.q1("SELECT COUNT(*) n FROM games WHERE analyzed=1 AND COALESCE(analysis_version,1)<?", (analyzer.ANALYSIS_VERSION,))["n"],
        "tablebases": analyzer.SYZYGY.exists() and any(analyzer.SYZYGY.glob("*.rtbw")),
        "tactics_db": tactics.available(),
    }


@app.get("/api/settings")
def get_settings():
    return db.get_settings()


@app.post("/api/settings")
def post_settings(body: dict = Body(...)):
    db.set_settings(body)
    importer.reattribute()
    return db.get_settings()


# ------------------------------------------------------------------ import
def _auto_enqueue():
    if db.get_settings().get("auto_analyze"):
        new = [r["id"] for r in db.q("SELECT id FROM games WHERE analyzed=0 AND user_color IS NOT NULL ORDER BY played_at DESC LIMIT 400")]
        if new:
            analyzer.enqueue(new)
        # games analysed by an older, less precise version are refreshed too (newest first), in the background
        ids = [r["id"] for r in db.q("""SELECT id FROM games WHERE analyzed=1 AND user_color IS NOT NULL AND COALESCE(analysis_version,1)<?
                                         ORDER BY played_at DESC LIMIT 60""", (analyzer.ANALYSIS_VERSION,))]
        if ids:
            analyzer.enqueue(ids, background=True)


def _import_job(months):
    importer.import_all(months)
    _auto_enqueue()


@app.post("/api/import")
def start_import(body: dict = Body(default={})):
    if importer.STATE["running"]:
        return importer.STATE
    threading.Thread(target=_import_job, args=(body.get("months"),), daemon=True).start()
    time.sleep(0.05)
    return importer.STATE


@app.post("/api/import/pgn")
def import_pgn(body: dict = Body(...)):
    n = importer.import_pgn_text(body.get("text", ""))
    if n:
        _auto_enqueue()
    return {"imported": n}


# ------------------------------------------------------------------ games
@app.get("/api/games")
def games(tc: str = None, days: int = None, color: str = None, result: str = None, opening: str = None, q: str = None,
          analyzed: int = None, starred: int = None, limit: int = 50, offset: int = 0):
    return stats.list_games(tc, days, color, result, opening, q, analyzed, starred, limit, offset)


@app.get("/api/games/{gid}")
def game(gid: int):
    g = stats.game_detail(gid)
    if not g:
        raise HTTPException(404)
    return g


@app.post("/api/games/{gid}/meta")
def game_meta(gid: int, body: dict = Body(...)):
    for k in ("notes", "starred", "reviewed"):
        if k in body:
            db.run(f"UPDATE games SET {k}=? WHERE id=?", (body[k], gid))
    return {"ok": True}


@app.delete("/api/games/{gid}")
def delete_game(gid: int):
    db.run("DELETE FROM puzzle_attempts WHERE puzzle_id IN (SELECT id FROM puzzles WHERE game_id=?)", (gid,))
    db.run("DELETE FROM puzzles WHERE game_id=?", (gid,))
    db.run("DELETE FROM moves WHERE game_id=?", (gid,))
    db.run("DELETE FROM games WHERE id=?", (gid,))
    return {"ok": True}


@app.get("/api/games/{gid}/pgn", response_class=PlainTextResponse)
def game_pgn(gid: int):
    g = db.q1("SELECT pgn FROM games WHERE id=?", (gid,))
    return g["pgn"] if g else ""


# ------------------------------------------------------------------ analysis queue
@app.post("/api/analyze")
def analyze(body: dict = Body(default={})):
    ids = body.get("ids")
    if body.get("depth"):
        db.set_settings({"depth": int(body["depth"])})
    if not ids:
        sql = "SELECT id FROM games WHERE user_color IS NOT NULL" + ("" if body.get("force") else " AND analyzed=0") + " ORDER BY played_at DESC"
        if body.get("limit"):
            sql += f" LIMIT {int(body['limit'])}"
        ids = [r["id"] for r in db.q(sql)]
    analyzer.enqueue(ids, front=bool(body.get("ids")))
    return {"queued": len(ids)}


@app.post("/api/analyze/cancel")
def analyze_cancel():
    analyzer.cancel()
    return {"ok": True}


# ------------------------------------------------------------------ stats / openings
@app.get("/api/stats/overview")
def overview(tc: str = None, days: int = None):
    return stats.overview(tc, days)


@app.get("/api/openings")
def openings_table(tc: str = None, days: int = None, color: str = None):
    return stats.opening_table(tc, days, color)


@app.get("/api/explorer")
def explorer(fenkey: str, color: str = "w", tc: str = None, days: int = None):
    return stats.explorer(fenkey, color, tc, days)


@app.get("/api/leaks")
def leaks(color: str = None, tc: str = None, days: int = None):
    return stats.opening_leaks(color, tc, days)


@app.get("/api/fenkey")
def fenkey(fen: str):
    b = chess.Board(fen)
    hit = openings.lookup(b)
    return {"fenkey": openings.fenkey(b), "opening": hit[1] if hit else None, "eco": hit[0] if hit else None}


# ------------------------------------------------------------------ training
@app.get("/api/puzzles/stats")
def puzzle_stats():
    return training.puzzle_stats()


@app.get("/api/puzzles/next")
def puzzle_next(mode: str = "due", tag: str = None, phase: str = None, exclude: int = None, theme: str = None):
    p = training.pick_next(mode, tag, phase, exclude, theme)
    return training.puzzle_for_client(p) if p else None


@app.post("/api/puzzles/{pid}/attempt")
def puzzle_attempt(pid: int, body: dict = Body(...)):
    try:
        return training.attempt(pid, body["uci"], body.get("time_ms", 0), body.get("record", True))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/puzzles/{pid}/step")
def puzzle_step(pid: int, body: dict = Body(...)):
    try:
        return training.check_step(pid, body["fen"], body["uci"], int(body.get("step", 0)))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/puzzles/{pid}/finish")
def puzzle_finish(pid: int, body: dict = Body(...)):
    r = training.finish(pid, body.get("outcome", "failed"), int(body.get("time_ms", 0)), int(body.get("hints", 0)))
    return r


@app.get("/api/puzzles/{pid}/hint")
def puzzle_hint(pid: int):
    p = db.q1("SELECT solution_uci FROM puzzles WHERE id=?", (pid,))
    return {"from": p["solution_uci"][:2]} if p else {}


@app.post("/api/bestmove")
def bestmove(body: dict = Body(...)):
    board = chess.Board(body["fen"])
    lines = training.util_engine().lines(board, 16, 1)
    uci = lines[0]["pv"][0]
    return {"uci": uci, "san": board.san(chess.Move.from_uci(uci)), "cp": lines[0]["cp"], "mate": lines[0]["mate"]}


@app.post("/api/puzzles/{pid}/giveup")
def puzzle_giveup(pid: int):
    return training.give_up(pid)


@app.post("/api/check_move")
def check_move(body: dict = Body(...)):
    try:
        return training.evaluate_move(body["fen"], body["uci"], 16)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/play")
def play(body: dict = Body(...)):
    return training.play_move(body["fen"], int(body.get("elo", 1600)), int(body.get("movetime", 600)))


@app.get("/api/endgames")
def endgames():
    return training.endgames()


@app.post("/api/endgames/{drill_id}/result")
def endgame_result(drill_id: str, body: dict = Body(...)):
    training.endgame_result(drill_id, bool(body.get("success")))
    daily.log("endgame")
    return {"ok": True}


@app.get("/api/sparring/position")
def sparring_position(kind: str = "critical", exclude: str = None):
    r = sparring.pick(kind, exclude)
    if not r:
        raise HTTPException(404, "Pas de position disponible pour ce type (analyse d'abord quelques parties).")
    return r


@app.get("/api/habits")
def habits_overview(tc: str = None, days: int = None):
    return habits.overview(days, tc)


# ------------------------------------------------------------------ rated tactics (lichess puzzle database)
@app.get("/api/tactics/stats")
def tactics_stats():
    return tactics.stats()


@app.get("/api/tactics/themes")
def tactics_themes():
    return tactics.theme_list()


@app.get("/api/tactics/next")
def tactics_next(mode: str = "rated", theme: str = None, exclude: str = None):
    return tactics.next_puzzle(mode, theme, exclude)


@app.post("/api/tactics/{pid}/result")
def tactics_result(pid: str, body: dict = Body(...)):
    try:
        return tactics.record(pid, body.get("outcome", "failed"), int(body.get("time_ms", 0)), int(body.get("hints", 0)), body.get("mode", "rated"))
    except ValueError as e:
        raise HTTPException(404, str(e))


# ------------------------------------------------------------------ daily plan
@app.get("/api/today")
def today():
    return daily.today_plan()


@app.post("/api/daily/log")
def daily_log(body: dict = Body(...)):
    if body.get("kind") in ("review", "endgame", "sparring", "calc"):
        daily.log(body["kind"])
    return {"ok": True}


# ------------------------------------------------------------------ opening repertoires
def _rep(rid: str):
    r = repertoire.get(rid)
    if not r:
        raise HTTPException(404, "répertoire introuvable")
    return r


@app.get("/api/repertoires")
def repertoires():
    return [repertoire.summary(r) for r in repertoire.all_reps()]


@app.get("/api/repertoires/{rid}")
def repertoire_detail(rid: str):
    return repertoire.detail(_rep(rid))


@app.get("/api/repertoires/{rid}/line")
def repertoire_line(rid: str, mode: str = "due", start: int = None):
    return repertoire.pick_line(_rep(rid), mode, start)


@app.post("/api/repertoires/{rid}/review")
def repertoire_review(rid: str, body: dict = Body(...)):
    _rep(rid)
    return repertoire.review(rid, body["fenkey"], bool(body.get("correct")))


# ------------------------------------------------------------------ live analysis websocket
@app.websocket("/ws/analyze")
async def ws_analyze(ws: WebSocket):
    # browsers send Origin on websockets: refuse other sites that would try to run Stockfish on this Mac
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=1008)
        return
    await ws.accept()
    transport, engine = await chess.engine.popen_uci(analyzer.STOCKFISH)
    await engine.configure({"Threads": 4, "Hash": 256})
    task = None

    async def run(fen: str, multipv: int):
        board = chess.Board(fen)
        if board.is_game_over():
            await ws.send_json({"depth": 0, "lines": [], "over": True})
            return
        lines = {}
        last = 0.0
        with await engine.analysis(board, chess.engine.Limit(), multipv=multipv) as analysis:
            async for info in analysis:
                if "pv" not in info or "score" not in info:
                    continue
                idx = info.get("multipv", 1)
                sc = info["score"].white()
                pv = info["pv"][:12]
                b = board.copy(stack=False)
                san = []
                for m in pv:
                    san.append(b.san(m))
                    b.push(m)
                lines[idx] = {"multipv": idx, "cp": sc.score(mate_score=analyzer.MATE_CP), "mate": sc.mate(),
                              "pv_uci": [m.uci() for m in pv], "pv_san": san, "depth": info.get("depth", 0)}
                now = time.time()
                if now - last > 0.12:
                    last = now
                    await ws.send_json({"depth": info.get("depth", 0), "nps": info.get("nps"), "lines": [lines[k] for k in sorted(lines)]})

    try:
        while True:
            msg = await ws.receive_json()
            if task:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                task = None
            if msg.get("stop"):
                continue
            task = asyncio.create_task(run(msg["fen"], int(msg.get("multipv", 3))))
    except WebSocketDisconnect:
        pass
    finally:
        if task:
            task.cancel()
        try:
            await engine.quit()
        except Exception:
            pass


class NoCacheStatic(StaticFiles):
    """Toujours revalider les fichiers du front : évite les vieux modules JS en cache."""
    async def get_response(self, path, scope):
        resp = await super().get_response(path, scope)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


app.mount("/", NoCacheStatic(directory=ROOT / "frontend", html=True), name="static")
