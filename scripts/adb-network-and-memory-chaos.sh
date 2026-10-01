#!/usr/bin/env bash
# Device-manipulation helpers for sync + low-resource testing. Usage: ./adb-network-and-memory-chaos.sh <airplane|slow|restore|lowmem|fillstorage|unfillstorage> [pkg]
set -euo pipefail
case "${1:?cmd}" in
  airplane)  adb shell cmd connectivity airplane-mode enable ;;          # API 30+. Older: settings put global airplane_mode_on 1 + broadcast
  restore)   adb shell cmd connectivity airplane-mode disable; adb shell svc wifi enable; adb shell svc data enable ;;
  slow)      adb emu network speed gsm; adb emu network delay gprs ;;   # emulator only: 2G-like speed and latency
  lowmem)    PKG=${2:?pkg}; adb shell am send-trim-memory "$PKG" COMPLETE   # simulate OS memory pressure
             adb shell dumpsys meminfo "$PKG" | head -30 ;;
  fillstorage) adb shell "dd if=/dev/zero of=/sdcard/fill.bin bs=1M count=${2:-2000}"; adb shell df /data ;;
  unfillstorage) adb shell rm -f /sdcard/fill.bin ;;
esac
