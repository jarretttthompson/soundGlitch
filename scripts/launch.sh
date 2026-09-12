#!/bin/sh
# Desktop launcher: start the local server if it isn't answering, then open the app.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8412
URL="http://localhost:$PORT/"

if ! curl -s -o /dev/null --max-time 1 "$URL"; then
  cd "$DIR" && nohup python3 serve.py "$PORT" >/dev/null 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    curl -s -o /dev/null --max-time 1 "$URL" && break
  done
fi

open "$URL"

# Belt and braces for shows: also hold off display sleep at the OS level for
# the next 12 hours (the page's own wake lock covers the normal case). Quit
# with: pkill -f "caffeinate -d"
pgrep -f "caffeinate -d" >/dev/null || nohup caffeinate -d -t 43200 >/dev/null 2>&1 &
