#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

windows_host_ip="$(awk '/nameserver/ {print $2; exit}' /etc/resolv.conf)"
export TIKTOK_PROXY_SERVER="${TIKTOK_PROXY_SERVER:-http://${windows_host_ip}:8899}"
npm run dev:api
