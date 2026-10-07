#!/usr/bin/env bash
# OPTIONAL (used by .github/workflows/deploy.yml): deploys one commit to an Azure App Service through Kudu's zip
# deploy and waits until it's live: Kudu has built it, and /health reports this commit with WhatsApp connected.
# Exits non-zero if it isn't live within about 12 minutes.
# Needs an Azure login (az) and two env vars: SCM (the app's Kudu https address) and SITE (its public https address).
set -euo pipefail
: "${SCM:?Set SCM to the app's Kudu (SCM) https address}"
: "${SITE:?Set SITE to the app's public https address}"
SHA="$1"
WORK=$(mktemp -d)
git archive --format=zip -o "$WORK/inkling.zip" "$SHA"
printf '{"sha":"%s"}\n' "$SHA" > "$WORK/version.json"
(cd "$WORK" && zip -q inkling.zip version.json)

TOKEN=$(az account get-access-token --query accessToken -o tsv)
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/zip" \
  --data-binary @"$WORK/inkling.zip" "$SCM/api/zipdeploy?isAsync=true"
echo "Uploaded $SHA; waiting for the build"

for _ in $(seq 60); do
  sleep 10
  STATE=$(curl -fsS -H "Authorization: Bearer $TOKEN" "$SCM/api/deployments/latest" | jq -r '"\(.status) \(.complete)"' || true)
  if [ "$STATE" = "4 true" ]; then echo "Built"; break; fi
  if [ "$STATE" = "3 true" ]; then echo "The build failed"; exit 1; fi
done

HEALTH=""
for _ in $(seq 48); do
  HEALTH=$(curl -fsS -m 10 "$SITE/health" || true)
  if [ "$(jq -r '.version // empty' <<<"$HEALTH" 2>/dev/null)" = "$SHA" ] && [ "$(jq -r '.whatsapp' <<<"$HEALTH" 2>/dev/null)" = "true" ]; then
    echo "Live: $SHA"
    exit 0
  fi
  sleep 10
done
echo "Not live in time. Last health: $HEALTH"
exit 1
