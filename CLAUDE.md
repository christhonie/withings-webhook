# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

A Cloudflare Worker that bridges **Withings** health data into **Intervals.icu**. Withings
sends webhook notifications when new data is recorded; the Worker fetches the data from the
Withings API, maps it to Intervals wellness fields, and pushes it via the Intervals API. It
handles body-composition measurements (weight, fat, etc.) and sleep summaries (stages, HR,
HRV, efficiency, sleep-mat check-ins).

## Source

Forked from [`baratzm/withings-webhook`](https://github.com/baratzm/withings-webhook)
(`upstream`); this fork (`origin = christhonie/withings-webhook`) adds the Withings Sleep
integration and hardening. Sync upstream changes via the `upstream` remote.

## Documentation

- `README.md` — full setup: OAuth, KV, secrets, custom Intervals fields, per-device field
  availability, and credential rotation. Read this before changing the integration.
- `docs/` — Antora design docs (`docs/modules/ROOT/pages/`): `design-sleep.adoc` and
  `design-naps.adoc` explain *why* the sleep design is the way it is (options, rationale,
  segmentation/aggregation decisions). Update these when the sleep behavior changes.

## Commands

```bash
npm run deploy   # wrangler deploy — push worker.js live
npm run dev      # wrangler dev — local dev server
npm run tail     # wrangler tail — stream live production logs (the only runtime visibility)
node --check worker.js   # syntax check before deploying
```

One-time OAuth / webhook setup is driven by `scripts/withings-bootstrap.sh`
(`authorize` → `token <code>` → seeds KV + subscribes webhooks; also `list` / `subscribe` /
`revoke`). Re-run `authorize`→`token` whenever the OAuth **scope** changes — appending scope
does not upgrade an existing refresh token.

There is **no automated test suite**. Verify changes with `node --check`, `wrangler tail`,
and live webhook triggers (curl the Worker with a `userid`/`appli` payload, then confirm the
result in Intervals).

## Architecture

Single file: `worker.js`. Everything hangs off the `fetch` handler.

- **Routing by `appli`** (Withings notification category): `1` → body composition
  (`measure?action=getmeas`); `44` → sleep summary (`v2/sleep?action=getsummary`); `52` →
  sleep-mat check-in (logged to KV, no push); `50/51` (bed in/out) ignored. New data types
  start as a new `appli` branch.
- **Field mapping is table-driven.** `FIELD_MAPPING` (body) and `SLEEP_FIELD_MAPPING` (sleep)
  declare each Withings field → Intervals field, whether it's a built-in or custom Intervals
  wellness field, and a transform/combine policy. Adding a metric = a table entry, not new
  control flow. Built-in `sleepSecs` stays in seconds; custom durations are minutes.
- **`sendToIntervals` is hardened** ("drop-unknown-and-retry"): if Intervals 422-rejects an
  unrecognized custom field, the Worker drops just that field and retries, so one unconfigured
  field never blocks the whole record. Custom Intervals fields must be created manually in the
  Intervals web UI (see README) before they populate.
- **Multi-series sleep nights** are merged per night via `combineSleepSeries` using each
  field's combine semantics (sum / min / max / weighted-avg / efficiency / first / last /
  primary). Nights are keyed by `series[].date`; a ±1-day query window handles after-midnight
  sessions and timezone rollover.
- **State lives in Workers KV** (`env.MY_KV`): OAuth tokens (`token_data_*`, `refresh_*`),
  dedupe markers (`sent_*`), failed-send retries (`retry_*`), and check-ins (`checkin_*`).
  Withings refresh tokens are **single-use** — any manual token refresh must persist the
  rotated token back to KV or the next refresh breaks.
- **Logging** is gated by `LOG_CONFIG` (category + per-operation allowlist). A `logApi`
  operation only emits if its key exists and is truthy in `LOG_CONFIG.operations`.

Secrets (Withings/Intervals/Telegram credentials) are set via `wrangler secret put` /
`wrangler secret bulk`, never committed; `.dev.vars` (gitignored) holds them for local use.
