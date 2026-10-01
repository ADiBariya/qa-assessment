#!/usr/bin/env bash
# Force the WorkManager sync job to run NOW (ignoring network/battery constraints). Usage: ./adb-force-sync.sh com.example.capi
set -euo pipefail
PKG=${1:?package}
# WorkManager delegates to JobScheduler (API 23+) via androidx.work.impl.background.systemjob.SystemJobService
adb shell dumpsys jobscheduler | grep -B2 -A12 "$PKG" | grep -E "JOB #|Service|Required constraints|Satisfied" || true
JOB_ID=$(adb shell dumpsys jobscheduler | grep -E "JOB #.*$PKG" | head -1 | sed -E 's/.*#[^/]*\/([0-9]+).*/\1/')
echo "job id: ${JOB_ID:?no scheduled job found - is there pending work?}"
adb shell cmd jobscheduler run -f "$PKG" "$JOB_ID"      # -f = force, skips constraints
adb logcat -d -s WM-WorkerWrapper WM-SystemJobService SyncWorker | tail -30
