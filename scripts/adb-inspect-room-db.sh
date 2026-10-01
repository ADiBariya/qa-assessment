#!/usr/bin/env bash
# Pull the Room DB of a DEBUGGABLE build from an UNROOTED device and inspect it. Usage: ./adb-inspect-room-db.sh com.example.capi [db_name]
# Release (non-debuggable) APK: see README "Scenario C" for the 3 fallbacks (QA flavour, repackaged debuggable APK, adb backup).
set -euo pipefail
PKG=${1:?package}; DB=${2:-app_database}; OUT=./db_dump_$(date +%s); mkdir -p "$OUT"
adb shell "run-as $PKG ls databases/" || { echo "run-as failed -> app is not debuggable, use a QA build"; exit 1; }
# WAL mode: copy ALL three files or you will miss recent (un-checkpointed) rows
for f in "$DB" "$DB-wal" "$DB-shm"; do adb exec-out "run-as $PKG cat databases/$f" > "$OUT/$f" 2>/dev/null || true; done
sqlite3 "$OUT/$DB" ".tables" ".schema"
sqlite3 -header -column "$OUT/$DB" "SELECT id, sync_status, retry_count, created_at, length(answers_json) AS bytes FROM survey_response ORDER BY created_at DESC LIMIT 20;"
echo "dump in $OUT"
