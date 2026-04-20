#!/usr/bin/env bash
# Wrapper that drives a clean setup run at a pace suitable for asciinema.
# Not part of normal development — only meaningful inside `asciinema rec`.

set -euo pipefail

pause() { sleep "${1:-1}"; }
type_line() { printf '%s\n' "$1"; sleep 0.4; }

cat <<'EOF'
# sts-project-vector-email — 60-second tour

EOF
pause 1

type_line '$ pnpm setup'
pause 1

# The real wizard is interactive. For the recording we run it normally and let
# the operator drive the prompts; this script exists so the `asciinema rec -c`
# command has a single entrypoint. If you want a fully unattended demo,
# replace the line below with a scripted `expect` flow.
pnpm setup

pause 2
echo
type_line '$ curl -sS -X POST http://localhost:3000/api/search \'
type_line '    -H "Authorization: Bearer $EMAIL_API_TOKEN" -H "Content-Type: application/json" \'
type_line "    -d '{\"query\": \"what did Sarah send about the budget?\", \"answer\": true}' | jq"
pause 1
curl -sS -X POST http://localhost:3000/api/search \
  -H "Authorization: Bearer ${EMAIL_API_TOKEN:-}" \
  -H "Content-Type: application/json" \
  -d '{"query":"what did Sarah send about the budget?","answer":true}' | jq . || true
pause 2

echo
echo "Done. Stop the recording with Ctrl+D."
