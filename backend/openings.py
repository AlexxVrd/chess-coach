"""ECO opening recognition from the lichess chess-openings tables."""
import csv
import io
import chess
import chess.pgn

from .db import DATA

_book = None  # epd -> (eco, name)


def fenkey(board: chess.Board) -> str:
    """Position key ignoring move counters (and en-passant square if not capturable)."""
    return board.epd(en_passant="legal")


def load():
    global _book
    if _book is not None:
        return _book
    book = {}
    for letter in "abcde":
        p = DATA / f"{letter}.tsv"
        if not p.exists():
            continue
        with open(p, newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f, delimiter="\t"):
                try:
                    game = chess.pgn.read_game(io.StringIO(row["pgn"]))
                    b = game.board()
                    for m in game.mainline_moves():
                        b.push(m)
                    # longest line wins for identical positions: keep first, names are unique per position
                    book[fenkey(b)] = (row["eco"], row["name"])
                except Exception:
                    continue
    _book = book
    return book


def lookup(board: chess.Board):
    return load().get(fenkey(board))


def classify_game(game: chess.pgn.Game):
    """Return (eco, name, book_plies) for the deepest known position along the main line.

    book_plies = number of plies for which every position was still in the opening table.
    """
    book = load()
    board = game.board()
    best = None
    last_in_book = 0
    ply = 0
    for m in game.mainline_moves():
        board.push(m)
        ply += 1
        hit = book.get(fenkey(board))
        if hit:
            best = hit
            last_in_book = ply
        elif ply - last_in_book > 4:
            break
    return (best[0], best[1], last_in_book) if best else (None, None, 0)
