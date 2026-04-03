#!/usr/bin/env bash
# Smoke check for deployed or local API (plan Phase 4).
set -euo pipefail
BASE="${1:-http://localhost:3001}"
echo "Smoke: GET $BASE/health"
curl -sfS "$BASE/health" | head -c 200
echo ""
echo "Smoke: GET $BASE/status"
curl -sfS "$BASE/status" | head -c 400
echo ""
echo "OK"
