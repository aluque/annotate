#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
URL="file://$DIR/index.html"

# Try common browsers in order, requesting a new window each time.
# Falls back to the system default if none are found.
if open -na "Google Chrome" --args "--new-window" "$URL" 2>/dev/null; then
    exit 0
fi
if open -na "Chromium" --args "--new-window" "$URL" 2>/dev/null; then
    exit 0
fi
if open -na "Firefox" --args "--new-window" "$URL" 2>/dev/null; then
    exit 0
fi
if open -na "Safari" "$URL" 2>/dev/null; then
    exit 0
fi

open "$URL"
