#!/bin/bash
set -euo pipefail

ROOT_DIR="${GITHUB_WORKSPACE}/mfe-infra"

APP_NAME="${INPUT_APP_NAME:?missing app_name}"
ENVIRONMENT="${INPUT_ENVIRONMENT:?missing environment}"
DEPLOY_URL="${INPUT_DEPLOY_URL:?missing deploy_url}"
STATUS="${INPUT_STATUS:-success}"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
Y="$(date -u +%Y)"
M="$(date -u +%m)"
D="$(date -u +%d)"

SOURCE_REPO="${GITHUB_REPOSITORY:-}"
WORKFLOW="${GITHUB_WORKFLOW:-}"
RUN_ID="${GITHUB_RUN_ID:-}"
RUN_ATTEMPT="${GITHUB_RUN_ATTEMPT:-}"
SHA="${GITHUB_SHA:-}"
REF="${GITHUB_REF:-}"
SERVER_URL="${GITHUB_SERVER_URL:-https://github.com}"
RUN_URL="${SERVER_URL}/${SOURCE_REPO}/actions/runs/${RUN_ID}"

EVENT_DIR="${ROOT_DIR}/deploys/${Y}/${M}/${D}"
mkdir -p "${EVENT_DIR}"

SAFE_REPO="${SOURCE_REPO//\//_}"
EVENT_FILE="${EVENT_DIR}/${SAFE_REPO}_${RUN_ID}_${RUN_ATTEMPT}.json"

export TS
export SOURCE_REPO
export WORKFLOW
export RUN_ID
export RUN_ATTEMPT
export RUN_URL
export APP_NAME
export ENVIRONMENT
export DEPLOY_URL
export STATUS
export SHA
export REF
# Load provider config for URL resolution in record.mjs
# Try digitalocean first, fall back to local
PROVIDER_CONFIG="${ROOT_DIR}/k8s/providers/digitalocean/config.env"
if [ ! -f "$PROVIDER_CONFIG" ]; then
  PROVIDER_CONFIG="${ROOT_DIR}/k8s/providers/local/config.env"
fi
if [ -f "$PROVIDER_CONFIG" ]; then
  source "$PROVIDER_CONFIG"
fi
export MFE_DOMAIN="${MFE_DOMAIN:-localtest.me}"
export PROTOCOL="${PROTOCOL:-http}"
export SERVICES_FILE="${GITHUB_WORKSPACE}/.env.services"

node "${GITHUB_ACTION_PATH}/record.mjs" "${EVENT_FILE}"

cd "${ROOT_DIR}"

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

git add "${EVENT_FILE#${ROOT_DIR}/}"

git commit -m "chore: record deploy event (${APP_NAME}/${ENVIRONMENT})" || exit 0

for i in 1 2 3 4 5; do
  git pull --rebase origin main || true
  if git push origin HEAD:main; then
    exit 0
  fi
  sleep $((i * 2))
done

echo "Failed to push deploy event after retries" >&2
exit 1
