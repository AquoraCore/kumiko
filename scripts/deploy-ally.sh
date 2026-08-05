#!/usr/bin/env bash
# Deploy changed files to the Kumiko home server (ROG Ally) over Cloudflare-tunnel SSH.
#
# THE GATE: this script is invoked via `npm run deploy`, and package.json defines a
# `predeploy` script (`vitest run`) that npm runs FIRST. If any test is red, npm aborts
# before this script executes — so nothing ever ships without the full regression suite
# passing. Every bug the user reports must gain a test in tests/unit (or tests/e2e) so it
# becomes part of this gate for all future deploys. See feedback_kumiko_predeploy_gate.
#
# Usage:  npm run deploy -- <file> [file ...]
#   e.g.  npm run deploy -- server/index.js web/index.html renderer/pdf.js
# Files are repo-relative; each is scp'd to C:/kumiko/<same-path>. If any server/*.js is
# among them, the KumikoServer scheduled task is restarted (server code is loaded at boot;
# static web/renderer/core assets are served no-store and go live on the next reload).
set -euo pipefail

HOST="kumiko-win"
FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  echo "usage: npm run deploy -- <file> [file ...]" >&2
  exit 1
fi

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then echo "ERROR: no such file: $f" >&2; exit 1; fi
  scp -o ConnectTimeout=25 "$f" "$HOST:C:/kumiko/$f"
  echo "  ✓ sent $f"
done

# Stamp a build id (git short SHA + local time) so the app can show which code is live,
# and ship it to the server. Shown in the AI settings modal ("รุ่น <build>").
BUILD="$(git rev-parse --short HEAD 2>/dev/null || echo nogit) $(date '+%Y-%m-%d %H:%M')"
printf '%s' "$BUILD" > BUILD.txt
scp -o ConnectTimeout=25 BUILD.txt "$HOST:C:/kumiko/BUILD.txt"
echo "  ✓ build = $BUILD"

# ALWAYS restart: bumps the per-boot assetVersion so every asset's ?v= changes → browsers
# are FORCED to refetch (no-store alone isn't always honored; a stale ?v= let old JS stick).
# CRITICAL: Stop/Start-ScheduledTask does NOT kill the node the task spawned (it's an orphaned
# grandchild of cmd/start.bat) — a stale node kept serving Aug-4 code for days. Force-kill node.
echo "restarting KumikoServer (force-kill node + bump ?v= cache-bust)…"
ssh -o ConnectTimeout=30 "$HOST" "powershell -NoProfile -Command \"Stop-ScheduledTask -TaskName KumikoServer; Start-Sleep 1; Get-Process node -EA SilentlyContinue | Stop-Process -Force; Start-Sleep 2; Start-ScheduledTask -TaskName KumikoServer; Start-Sleep 5\""

echo "health check:"
ssh -o ConnectTimeout=30 "$HOST" "powershell -NoProfile -Command \"try { 'http=' + (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4321/ -TimeoutSec 8).StatusCode } catch { \$_.Exception.Message }\""
echo "deploy done."
