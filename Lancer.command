#!/bin/bash
# Lance Chess Coach en local : http://127.0.0.1:8765
cd "$(dirname "$0")"
source .venv/bin/activate
(sleep 1.5 && open "http://127.0.0.1:8765") &
exec uvicorn backend.main:app --host 127.0.0.1 --port 8765
