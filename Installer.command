#!/bin/bash
# Installation unique (Mac) : crée l'environnement Python et installe Stockfish.
cd "$(dirname "$0")"
command -v brew >/dev/null || { echo "Installe d'abord Homebrew : https://brew.sh"; exit 1; }
command -v python3 >/dev/null || brew install python
command -v stockfish >/dev/null || brew install stockfish
python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt
echo "Installation terminée. Lance ensuite Lancer.command"
