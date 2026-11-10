"""Stockfish game analysis: evals, move classification, accuracy, tactical tags, puzzle extraction."""
import io
import json
import math
import shutil
import statistics
import subprocess
import sys
import threading
import time

import chess
import chess.engine
import chess.pgn

from . import db, openings

STOCKFISH = shutil.which("stockfish") or "/opt/homebrew/bin/stockfish"
ANALYSIS_VERSION = 2
# scan = depth of the first pass over every position; verify = depth used to re-check suspicious moves
QUALITY = {
    "fast": {"scan": 11, "verify": 16, "vtime": 4, "vmax": 20, "stime": 0.5},
    "balanced": {"scan": 14, "verify": 22, "vtime": 8, "vmax": 30, "stime": 1.0},
    "max": {"scan": 18, "verify": 28, "vtime": 30, "vmax": 60, "stime": 3.0},
}
SYZYGY = db.DATA / "syzygy"
VAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 100}
MATE_CP = 10000


# ---------------------------------------------------------------- math helpers
def winprob(cp: float) -> float:
    """Win percentage (0-100) for the side whose eval is `cp` (lichess model)."""
    cp = max(-1500, min(1500, cp))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def move_accuracy(loss: float) -> float:
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss) - 3.1669))


def classify_loss(loss: float) -> str:
    if loss <= 2:
        return "excellent"
    if loss <= 5:
        return "good"
    if loss <= 10:
        return "inaccuracy"
    if loss <= 20:
        return "mistake"
    return "blunder"


# ---------------------------------------------------------------- board helpers
def material(board: chess.Board, color: bool) -> int:
    return sum(VAL[p.piece_type] * 1 for p in board.piece_map().values() if p.color == color and p.piece_type != chess.KING)


def see_rec(b: chess.Board, sq: int) -> int:
    best = 0
    for m in list(b.generate_legal_captures(to_mask=chess.BB_SQUARES[sq])):
        victim = b.piece_at(sq)
        if victim is None:
            continue
        v = VAL[victim.piece_type]
        b.push(m)
        g = v - see_rec(b, sq)
        b.pop()
        if g > best:
            best = g
    return best


def see(board: chess.Board, move: chess.Move) -> int:
    """Net material gain for the side playing `move` if the exchange on the target square plays out."""
    if not board.is_capture(move):
        return -see_rec_after(board, move)
    victim = board.piece_at(move.to_square)
    v = VAL[chess.PAWN] if (victim is None) else VAL[victim.piece_type]  # en passant
    b = board.copy(stack=False)
    b.push(move)
    return v - see_rec(b, move.to_square)


def see_rec_after(board: chess.Board, move: chess.Move) -> int:
    b = board.copy(stack=False)
    b.push(move)
    return see_rec(b, move.to_square)


def fork_after(board: chess.Board, move: chess.Move) -> bool:
    """True if `move` lands a piece that forks >=2 valuable/undefended enemy pieces and is itself safe."""
    piece = board.piece_at(move.from_square)
    if piece is None or piece.piece_type == chess.KING:
        return False
    b = board.copy(stack=False)
    b.push(move)
    sq = move.to_square
    enemy = b.turn
    moved = b.piece_at(sq)
    if moved is None:
        return False
    targets = 0
    for t in b.attacks(sq):
        p = b.piece_at(t)
        if p is None or p.color != enemy or p.piece_type == chess.PAWN:
            continue
        if p.piece_type == chess.KING or VAL[p.piece_type] > VAL[moved.piece_type] or not b.is_attacked_by(enemy, t):
            targets += 1
    if targets < 2:
        return False
    return see_rec(b, sq) <= 0


def game_phase(board: chess.Board, fullmove: int) -> str:
    pieces = sum(1 for p in board.piece_map().values() if p.piece_type not in (chess.PAWN, chess.KING))
    if pieces <= 6:
        return "endgame"
    if fullmove <= 10:
        return "opening"
    return "middlegame"


# ---------------------------------------------------------------- engine wrapper
class Engine:
    """Pool of single-thread Stockfish processes (much faster than one multi-thread engine at fixed depth).

    Uses Syzygy tablebases (data/syzygy) when present, so simple endgames are judged exactly."""

    def __init__(self, workers: int, hash_mb: int, nice: bool = True, eco: bool = False):
        import queue
        self.n = max(1, workers)
        self.pool = queue.Queue()
        self.all = []
        syz = str(SYZYGY) if SYZYGY.exists() and any(SYZYGY.glob("*.rtbw")) else None
        for _ in range(self.n):
            # low priority so the UI stays responsive while a batch analysis is running
            cmd = ["nice", "-n", "10", STOCKFISH] if nice else [STOCKFISH]
            if eco and sys.platform == "darwin":
                cmd = ["taskpolicy", "-b"] + cmd      # priorité « arrière-plan » : cœurs économes, moins de batterie
            e = chess.engine.SimpleEngine.popen_uci(cmd)
            opts = {"Threads": 1, "Hash": hash_mb}
            if syz:
                opts["SyzygyPath"] = syz
            e.configure(opts)
            self.all.append(e)
            self.pool.put(e)

    def close(self):
        for e in self.all:
            try:
                e.quit()
            except Exception:
                try:
                    e.close()
                except Exception:
                    pass

    def _analyse(self, board, limit, **kw):
        e = self.pool.get()
        try:
            return e.analyse(board, limit, **kw)
        finally:
            self.pool.put(e)

    def lines(self, board: chess.Board, depth: int, multipv: int = 2, tlimit: float | None = None):
        """Return list of {cp (white pov), mate (white pov, moves), pv [uci]} using the eval cache."""
        key = openings.fenkey(board)
        row = db.q1("SELECT depth, lines FROM evals WHERE fenkey=?", (key,))
        if row and row["depth"] >= depth:
            cached = json.loads(row["lines"])
            if len(cached) >= min(multipv, board.legal_moves.count()):
                return cached
        infos = self._analyse(board, chess.engine.Limit(depth=depth, time=tlimit), multipv=multipv)
        out, reached = [], 99
        for inf in infos:
            sc = inf["score"].white()
            reached = min(reached, inf.get("depth", depth))
            out.append({"cp": sc.score(mate_score=MATE_CP), "mate": sc.mate(), "pv": [m.uci() for m in inf.get("pv", [])[:10]]})
        # never overwrite a deeper cached analysis with a shallower one
        if not row or reached >= row["depth"]:
            db.run("INSERT OR REPLACE INTO evals(fenkey, depth, lines) VALUES(?,?,?)", (key, reached, json.dumps(out)))
        return out

    def eval_move(self, board: chess.Board, move: chess.Move, depth: int, tlimit: float | None = None):
        """Evaluate one specific move at the same depth as the best-move search (apples to apples)."""
        after = board.copy(stack=False)
        after.push(move)
        if after.is_game_over():
            t = terminal_line(after)[0]
            return {"cp": t["cp"], "mate": t["mate"], "pv": [move.uci()]}
        key = openings.fenkey(board)
        row = db.q1("SELECT depth, cp, mate, pv FROM move_evals WHERE fenkey=? AND uci=?", (key, move.uci()))
        if row and row["depth"] >= depth:
            return {"cp": row["cp"], "mate": row["mate"], "pv": row["pv"].split()}
        info = self._analyse(board, chess.engine.Limit(depth=depth, time=tlimit), root_moves=[move])
        sc = info["score"].white()
        out = {"cp": sc.score(mate_score=MATE_CP), "mate": sc.mate(), "pv": [m.uci() for m in info.get("pv", [])[:10]]}
        db.run("INSERT OR REPLACE INTO move_evals(fenkey, uci, depth, cp, mate, pv) VALUES(?,?,?,?,?,?)",
               (key, move.uci(), info.get("depth", depth), out["cp"], out["mate"], " ".join(out["pv"])))
        return out

    def lines_many(self, boards, depth, multipv=2, progress=None, tlimit=None):
        from concurrent.futures import ThreadPoolExecutor
        done = [0]

        def job(b):
            r = terminal_line(b) if b.is_game_over() else self.lines(b, depth, multipv, tlimit)
            done[0] += 1
            if progress:
                progress(done[0], len(boards))
            return r
        with ThreadPoolExecutor(self.n) as ex:
            return list(ex.map(job, boards))


def san_line(board: chess.Board, pv_uci: list, n: int = 6) -> str:
    b = board.copy(stack=False)
    out = []
    for u in pv_uci[:n]:
        try:
            m = chess.Move.from_uci(u)
            if m not in b.legal_moves:
                break
            out.append(b.san(m))
            b.push(m)
        except Exception:
            break
    return " ".join(out)


# ---------------------------------------------------------------- per-game analysis
def terminal_line(board: chess.Board):
    if board.is_checkmate():
        # side to move is mated: winner is the other side
        winner_white = board.turn == chess.BLACK
        return [{"cp": MATE_CP if winner_white else -MATE_CP, "mate": 0, "pv": []}]
    return [{"cp": 0, "mate": None, "pv": []}]


def parse_tc(tc: str):
    try:
        base, _, inc = tc.partition("+")
        return int(base.split("/")[-1]), int(inc or 0)
    except Exception:
        return None, 0


# ---------------------------------------------------------------- tactical themes (lichess-style keys)
def detect_themes(before: chess.Board, pv: list, mate, wb: float, phase: str) -> list:
    """Describe what the best line does: mateInN, fork, hangingPiece, winMaterial, sacrifice, promotion, defensiveMove, endgame."""
    themes = []
    if not pv:
        return themes
    try:
        first = chess.Move.from_uci(pv[0])
    except Exception:
        return themes
    if first not in before.legal_moves:
        return themes
    mover = before.turn
    sign = 1 if mover == chess.WHITE else -1
    if mate is not None and mate * sign > 0:
        themes.append(f"mateIn{min(mate * sign, 5)}")
    # material along the (even-length) main line
    b = before.copy(stack=False)
    start = material(b, mover) - material(b, not mover)
    promo = False
    n = 0
    for u in pv[:6]:
        try:
            m = chess.Move.from_uci(u)
        except Exception:
            break
        if m not in b.legal_moves:
            break
        promo = promo or bool(m.promotion)
        b.push(m)
        n += 1
    if n % 2 == 1 and n > 1:      # end after the opponent's reply
        b.pop()
    gain = (material(b, mover) - material(b, not mover)) - start
    victim = before.piece_at(first.to_square)
    if before.is_capture(first) and victim is not None and VAL[victim.piece_type] >= 3 and see(before, first) >= 3:
        themes.append("hangingPiece")
    if fork_after(before, first):
        themes.append("fork")
    if gain >= 2 and "hangingPiece" not in themes and not any(t.startswith("mateIn") for t in themes):
        themes.append("winMaterial")
    if promo:
        themes.append("promotion")
    piece = before.piece_at(first.from_square)
    if piece and piece.piece_type != chess.PAWN and VAL[piece.piece_type] >= 3 and see(before, first) <= -2:
        themes.append("sacrifice")
    if wb < 40 and not themes:
        themes.append("defensiveMove")
    if phase == "endgame":
        themes.append("endgame")
    return themes


def _prelim(lb, la, uci, sign):
    """Quick numbers from the scan pass: (loss, gap, best_uci)."""
    best = lb[0]
    best_uci = best["pv"][0] if best["pv"] else uci
    ev = la[0]["cp"]
    for l in lb:
        if l["pv"] and l["pv"][0] == uci:
            ev = l["cp"]
    loss = 0.0 if uci == best_uci else max(0.0, winprob(sign * best["cp"]) - winprob(sign * ev))
    gap = (winprob(sign * best["cp"]) - winprob(sign * lb[1]["cp"])) if len(lb) > 1 else 0.0
    return loss, gap, best_uci


# ---------------------------------------------------------------- per-game analysis (two passes)
def analyze_game(engine: Engine, game_id: int, cfg: dict, progress=None):
    """Pass 1 scans every position quickly. Pass 2 re-checks every suspicious move (and only-move candidates)
    at a much higher depth, comparing the played move to the best move *at the same depth*."""
    from concurrent.futures import ThreadPoolExecutor
    g = db.q1("SELECT * FROM games WHERE id=?", (game_id,))
    game = chess.pgn.read_game(io.StringIO(g["pgn"]))
    nodes = list(game.mainline())
    base_s, inc_s = parse_tc(g["time_control"] or "")
    boards = [game.board()]
    for n in nodes:
        b = boards[-1].copy(stack=False)
        b.push(n.move)
        boards.append(b)
    N = len(nodes)
    book_plies = g["book_plies"] or 0
    ver_depth = cfg["verify"]

    # ---- pass 1
    def p1(done, total):
        if progress:
            progress(done, total + 1)
    scan = engine.lines_many(boards, cfg["scan"], 2, p1, cfg.get("stime"))

    # ---- choose what to verify
    cand = []
    for i, node in enumerate(nodes):
        if i + 1 <= book_plies or boards[i].is_game_over():
            continue
        sign = 1 if boards[i].turn == chess.WHITE else -1
        uci = node.move.uci()
        loss, gap, best_uci = _prelim(scan[i], scan[i + 1], uci, sign)
        b0, la0 = scan[i][0], scan[i + 1][0]
        mate_hit = (b0["mate"] is not None and b0["mate"] * sign > 0) or (la0["mate"] is not None and la0["mate"] * sign < 0)
        if loss >= 3.5 or (loss <= 1 and gap >= 8) or mate_hit:
            cand.append((loss + gap / 4 + (20 if mate_hit else 0), i))
    cand.sort(reverse=True)
    cand = sorted(i for _, i in cand[:cfg["vmax"]])
    total_steps = len(boards) + len(cand)

    verified = {}

    def verify(i):
        before = boards[i]
        move = nodes[i].move
        top = engine.lines(before, ver_depth, 3, cfg["vtime"])
        played = None
        for l in top:
            if l["pv"] and l["pv"][0] == move.uci():
                played = {"cp": l["cp"], "mate": l["mate"], "pv": l["pv"]}
        if played is None:
            played = engine.eval_move(before, move, ver_depth, cfg["vtime"])
        verified[i] = {"top": top, "played": played}
        if progress:
            progress(len(boards) + len(verified), total_steps)
    if cand:
        with ThreadPoolExecutor(engine.n) as ex:
            list(ex.map(verify, cand))

    # ---- assemble rows
    rows = []
    prev_clock = {chess.WHITE: base_s, chess.BLACK: base_s}
    wp_white = [winprob(l[0]["cp"]) for l in scan]
    prev_loss = 0.0
    for i, node in enumerate(nodes):
        before, after = boards[i], boards[i + 1]
        mover = before.turn
        sign = 1 if mover == chess.WHITE else -1
        move = node.move
        uci = move.uci()
        san = before.san(move)
        V = verified.get(i)
        if V:
            lb = V["top"]
            ev_after, mate_after, opp_pv = V["played"]["cp"], V["played"]["mate"], V["played"]["pv"][1:]
        else:
            lb, la = scan[i], scan[i + 1]
            ev_after, mate_after, opp_pv = la[0]["cp"], la[0]["mate"], la[0]["pv"]
            for l in lb:
                if l["pv"] and l["pv"][0] == uci:
                    ev_after, mate_after, opp_pv = l["cp"], l["mate"], l["pv"][1:]
        best = lb[0]
        best_uci = best["pv"][0] if best["pv"] else uci
        best_move = chess.Move.from_uci(best_uci)
        best_san = before.san(best_move) if best_move in before.legal_moves else best_uci
        second = lb[1] if len(lb) > 1 else None
        second_san = None
        if second and second["pv"]:
            sm = chess.Move.from_uci(second["pv"][0])
            second_san = before.san(sm) if sm in before.legal_moves else None
        eval_before = best["cp"]
        wb, wa = winprob(sign * eval_before), winprob(sign * ev_after)
        loss = 0.0 if uci == best_uci else max(0.0, wb - wa)
        gap = (wb - winprob(sign * second["cp"])) if second else 0.0
        cp_loss = 0 if uci == best_uci else max(0, max(-1000, min(1000, sign * eval_before)) - max(-1000, min(1000, sign * ev_after)))

        ply = i + 1
        phase = game_phase(before, before.fullmove_number)
        is_book = ply <= book_plies
        tags = []
        best_mate_me = best["mate"] is not None and best["mate"] * sign > 0
        kept_mate = mate_after is not None and mate_after * sign > 0

        if is_book:
            cls = "book"
        elif uci == best_uci:
            cls = "best"
        else:
            cls = classify_loss(loss)
            # missing a forced mate is serious even when the resulting position is still winning
            if best_mate_me and not kept_mate and cls in ("excellent", "good", "inaccuracy", "mistake"):
                floor = "mistake" if best["mate"] * sign <= 3 else "inaccuracy"
                order = ["excellent", "good", "inaccuracy", "mistake", "blunder"]
                if order.index(floor) > order.index(cls):
                    cls = floor
                tags.append("mate_missed")

        # ---- special good moves (need a verified, same-depth comparison)
        if not is_book and V and loss <= 1.0:
            is_recap = before.is_capture(move) and i > 0 and nodes[i - 1].move.to_square == move.to_square
            if uci == best_uci and second is not None and gap >= 12 and 10 < wb < 92 and not is_recap and before.legal_moves.count() > 1:
                cls = "great"
            piece = before.piece_at(move.from_square)
            if piece and piece.piece_type not in (chess.PAWN, chess.KING) and VAL[piece.piece_type] >= 3 and wb < 92 and wa >= 45 \
                    and loss <= 2 and best["mate"] is None and see(before, move) <= -2:
                cls = "brilliant"

        # ---- tactical tags on imperfect moves
        if not is_book and loss >= 10:
            if mate_after is not None and mate_after * sign < 0 and not (best["mate"] is not None and best["mate"] * sign < 0):
                tags.append("mate_allowed")
            opp = chess.Move.from_uci(opp_pv[0]) if opp_pv else None
            if opp is not None and opp in after.legal_moves:
                if after.is_capture(opp) and see(after, opp) >= 2:
                    tags.append("hung_piece")
                elif fork_after(after, opp):
                    tags.append("allowed_fork")
            if best_move in before.legal_moves:
                if before.is_capture(best_move) and see(before, best_move) >= 2 and not before.is_capture(move):
                    tags.append("missed_material")
                if fork_after(before, best_move):
                    tags.append("missed_fork")
            if wb >= 80 and wa <= 62:
                tags.append("threw_advantage")
            if prev_loss >= 15 and i > 0:
                tags.append("missed_opportunity")
            if best_mate_me and "mate_missed" not in tags and not kept_mate:
                tags.append("mate_missed")

        # ---- clocks
        clk = node.clock()
        clock_ms = int(clk * 1000) if clk is not None else None
        spent_ms = None
        if clk is not None:
            pc = prev_clock[mover]
            if pc is not None:
                spent_ms = max(0, int((pc - clk + inc_s) * 1000))
            prev_clock[mover] = clk
            if base_s and not is_book:
                if clk < max(20, 0.08 * base_s) and loss >= 10:
                    tags.append("time_trouble")
                if spent_ms is not None and spent_ms < 3000 and loss >= 20 and before.legal_moves.count() > 3:
                    tags.append("too_fast")

        rows.append({
            "game_id": game_id, "ply": ply, "color": "w" if mover == chess.WHITE else "b", "san": san, "uci": uci,
            "fen_before": before.fen(), "fenkey": openings.fenkey(before),
            "eval_before": eval_before, "eval_after": ev_after,
            "mate_before": best["mate"], "mate_after": mate_after,
            "best_uci": best_uci, "best_san": best_san,
            "second_uci": second["pv"][0] if second and second["pv"] else None, "second_eval": second["cp"] if second else None,
            "second_san": second_san,
            "pv": " ".join(best["pv"][:8]), "pv_san": san_line(before, best["pv"], 6),
            "refut_san": san_line(after, opp_pv, 5) if opp_pv and not after.is_game_over() else "",
            "loss": round(loss, 2), "gap": round(gap, 1), "cp_loss": cp_loss,
            "accuracy": round(move_accuracy(loss), 2), "cls": cls, "phase": phase, "is_book": 1 if is_book else 0,
            "verified": 1 if V else 0, "depth": ver_depth if V else cfg["scan"],
            "clock_ms": clock_ms, "spent_ms": spent_ms, "tags": json.dumps(tags),
        })
        prev_loss = loss if not is_book else 0.0

    # ---- game-level accuracy / ACPL (lichess style volatility weighting)
    def side_stats(color):
        idx = [k for k, r in enumerate(rows) if r["color"] == color and not r["is_book"]]
        if not idx:
            return None, None
        w = max(2, min(8, len(wp_white) // 10))
        weights, accs = [], []
        for k in idx:
            lo, hi = max(0, k - w // 2), min(len(wp_white), k + w // 2 + 2)
            seg = wp_white[lo:hi]
            sd = statistics.pstdev(seg) if len(seg) > 1 else 0
            weights.append(max(0.5, min(12, sd)))
            accs.append(rows[k]["accuracy"])
        wmean = sum(a * x for a, x in zip(accs, weights)) / sum(weights)
        hmean = len(accs) / sum(1 / max(a, 1) for a in accs)
        acpl = sum(rows[k]["cp_loss"] for k in idx) / len(idx)
        return round((wmean + hmean) / 2, 1), round(acpl, 1)

    accw, acplw = side_stats("w")
    accb, acplb = side_stats("b")

    c = db.conn()
    c.execute("DELETE FROM moves WHERE game_id=?", (game_id,))
    cols = ["game_id", "ply", "color", "san", "uci", "fen_before", "fenkey", "eval_before", "eval_after", "mate_before",
            "mate_after", "best_uci", "best_san", "second_uci", "second_eval", "second_san", "pv", "pv_san", "refut_san",
            "loss", "gap", "accuracy", "cls", "phase", "is_book", "verified", "depth", "clock_ms", "spent_ms", "tags"]
    c.executemany(f"INSERT INTO moves({','.join(cols)}) VALUES({','.join('?' * len(cols))})", [[r[k] for k in cols] for r in rows])
    c.execute("""UPDATE games SET analyzed=1, analysis_depth=?, analysis_version=?, acc_white=?, acc_black=?, acpl_white=?, acpl_black=?
                 WHERE id=?""", (ver_depth, ANALYSIS_VERSION, accw, accb, acplw, acplb, game_id))
    c.commit()
    extract_puzzles(game_id, rows)


# ---------------------------------------------------------------- puzzles from own mistakes
def extract_puzzles(game_id: int, rows=None, min_loss: float = 12.0):
    """Turn the user's costly mistakes into puzzles. Only *verified* moves with a clear best move qualify,
    so the trainer never asks for a move the engine itself is unsure about."""
    g = db.q1("SELECT user_color FROM games WHERE id=?", (game_id,))
    if not g or not g["user_color"]:
        return 0
    if rows is None:
        rows = db.q("SELECT * FROM moves WHERE game_id=? ORDER BY ply", (game_id,))
    # untouched puzzles of this game are regenerated from the fresh analysis
    db.run("DELETE FROM puzzles WHERE game_id=? AND reps=0 AND lapses=0 AND COALESCE(attempts,0)=0", (game_id,))
    n = 0
    for m in rows:
        if m["color"] != g["user_color"] or m["is_book"] or not m.get("verified") or (m["loss"] or 0) < min_loss:
            continue
        sign = 1 if m["color"] == "w" else -1
        wb = winprob(sign * m["eval_before"])
        if wb < 15:            # already lost: not instructive
            continue
        clear = (m.get("gap") or 0) >= 8 or (m["mate_before"] is not None and m["mate_before"] * sign > 0) or (m["loss"] or 0) >= 25
        if not clear:
            continue
        if db.q1("SELECT id FROM puzzles WHERE fen=?", (m["fen_before"],)):
            continue
        board = chess.Board(m["fen_before"])
        pv = (m["pv"] or "").split()
        themes = detect_themes(board, pv, m["mate_before"], wb, m["phase"])
        mate_in = None
        if m["mate_before"] is not None and m["mate_before"] * sign > 0:
            mate_in = m["mate_before"] * sign
        tags = m["tags"] if isinstance(m["tags"], str) else json.dumps(m["tags"])
        db.run("""INSERT INTO puzzles(game_id, ply, fen, side, solution_uci, solution_san, pv_san, played_uci, played_san,
                  loss, eval_before, tags, phase, due_at, created_at, kind, themes, gap, solution_pv, refut_san, mate_in)
                  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
               (game_id, m["ply"], m["fen_before"], m["color"], m["best_uci"], m["best_san"], m["pv_san"], m["uci"], m["san"],
                m["loss"], m["eval_before"], tags, m["phase"], 0, int(time.time()), "own", json.dumps(themes), m.get("gap"),
                " ".join(pv), m.get("refut_san"), mate_in))
        n += 1
    return n


# ---------------------------------------------------------------- background queue
Q = {"ids": [], "current": None, "ply": 0, "total": 0, "done": 0, "running": False, "error": None, "cancel": False,
     "bgids": [], "paused": None}
_qlock = threading.Lock()


_batt = {"t": 0.0, "v": False}


def on_battery() -> bool:
    """True si le Mac fonctionne sur batterie (macOS). Mis en cache 20 s."""
    if sys.platform != "darwin":
        return False
    if time.time() - _batt["t"] > 20:
        try:
            out = subprocess.run(["pmset", "-g", "batt"], capture_output=True, text=True, timeout=3).stdout
            _batt["v"] = "Battery Power" in out
        except Exception:  # noqa: BLE001
            _batt["v"] = False
        _batt["t"] = time.time()
    return _batt["v"]


def enqueue(ids, background=False, front=False):
    """background=True : mise à jour automatique des anciennes analyses, mise en pause sur batterie.
    front=True : demande manuelle, passe devant le reste de la file."""
    with _qlock:
        fresh = [i for i in ids if i != Q["current"]]
        if background:
            Q["bgids"] += [i for i in fresh if i not in Q["bgids"] and i not in Q["ids"]]
        else:
            Q["bgids"] = [i for i in Q["bgids"] if i not in fresh]
            if front:
                Q["ids"] = fresh + [i for i in Q["ids"] if i not in fresh]
            else:
                Q["ids"] += [i for i in fresh if i not in Q["ids"]]
        if not Q["running"] and (Q["ids"] or Q["bgids"]):
            Q["running"] = True
            Q["done"] = 0
            Q["cancel"] = False
            threading.Thread(target=_worker, daemon=True).start()


def cancel():
    with _qlock:
        Q["ids"].clear()
        Q["bgids"].clear()
        Q["cancel"] = True


def _worker():
    s = db.get_settings()
    cfg = QUALITY.get(s.get("quality", "balanced"), QUALITY["balanced"])
    eng = None
    released = False
    try:
        eng = Engine(int(s.get("threads", 8)), min(int(s.get("hash_mb", 64)), 96), eco=not Q["ids"])
        while True:
            with _qlock:
                if (not Q["ids"] and not Q["bgids"]) or Q["cancel"]:
                    # release the queue under the same lock that saw it empty: an enqueue() arriving right
                    # after sees running=False and starts a new worker instead of leaving its ids stranded
                    if Q["cancel"]:
                        Q["ids"].clear()
                        Q["bgids"].clear()
                    Q["running"] = False
                    Q["current"] = None
                    Q["paused"] = None
                    released = True
                    break
                if Q["ids"]:
                    Q["paused"] = None
                    gid = Q["ids"].pop(0)
                    Q["current"] = gid
                elif s.get("pause_on_battery", True) and on_battery():
                    Q["paused"] = "batterie"
                    gid = None
                else:
                    Q["paused"] = None
                    gid = Q["bgids"].pop(0)
                    Q["current"] = gid
            if gid is None:
                time.sleep(5)        # branche le Mac pour reprendre l'analyse de fond
                s = db.get_settings()
                continue
            try:
                def prog(i, n):
                    Q["ply"], Q["total"] = i, n
                analyze_game(eng, gid, cfg, prog)
                Q["done"] += 1
            except Exception as e:  # noqa: BLE001
                Q["error"] = f"partie {gid}: {e}"
    except Exception as e:  # noqa: BLE001  (e.g. Stockfish missing)
        Q["error"] = f"moteur : {e}"
    finally:
        if not released:
            with _qlock:
                Q["running"] = False
                Q["current"] = None
        if eng:
            eng.close()
