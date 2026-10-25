#!/usr/bin/env sh
# Development server: fake OpenID tokens accepted (DEV_AUTH=1), bound to loopback only.
# Open the printed harness URL: two widgets (Alice, Bob) under a fake Matrix client.
# PORT overrides the port (default 8090); extra arguments go to node (e.g. --watch).
set -eu
cd "$(dirname "$0")/.."
PORT="${PORT:-8090}"
echo "Fake Matrix harness: http://127.0.0.1:${PORT}/dev/fake-matrix.html"
echo "Plain tab (dev login): http://127.0.0.1:${PORT}/"
DEV_AUTH=1 HOST=127.0.0.1 PORT="$PORT" exec node "$@" server/index.js
