#!/bin/bash
# The Vercel build for the sync relay.
#
# WHY THIS IS A FILE AND NOT A `buildCommand` STRING.
# It used to live inline in server/vercel.json. Vercel's config schema caps `buildCommand` at
# 256 characters and the command had grown to 271, so the project could not be deployed at all:
#
#     The `vercel.json` schema validation failed with the following message:
#     `buildCommand` should NOT be longer than 256 characters
#
# The overflow was the explanation, not the logic — which is the tell that the prose wanted a file.
# A script can hold both, and `.github/scripts/check-server-config.mjs` rows V3–V6 follow the
# delegation and scan this file, so the guarantees below are still enforced by name.
#
# ── WHAT IT DOES, AND THE TWO RULES IT EXISTS TO KEEP ────────────────────────────────────────
#
# 1. `prisma generate` ALWAYS runs. The client is generated code; without it the adapter cannot
#    import @prisma/client and every route 500s.
#
# 2. `prisma migrate deploy` runs ONLY against a database that is allowed to be migrated:
#    production, or a preview whose database has been explicitly declared isolated. A preview
#    deploy that migrated the production DATABASE_URL would apply a feature branch's schema to
#    the family's live data — from a branch nobody reviewed, with no tag and no announcement.
#    LZP_PREVIEW_DB_IS_ISOLATED must therefore never be set to "true" until Preview genuinely has
#    its own database (docs/v2/RELEASE.md § "Preview environments").
#
#    It is `migrate deploy` and never `migrate dev` or `db push`: deploy APPLIES committed
#    migrations and refuses to invent one, so an empty Postgres stays empty rather than being
#    silently reshaped to match whatever schema.prisma happens to say today. Row V4 fails the
#    build if that ever changes.
set -euo pipefail

# THE RELAY HAS NO WEBSITE, AND `public/` IS HOW WE SAY SO TO VERCEL.
#
# Vercel requires an output directory after a build and fails with
# "No Output Directory named "public" found after the Build completed" without one. This project
# is serverless functions and nothing else: every route lives under `api/`, and `/` should answer
# 404 because a blind relay is not a page anyone should land on.
#
# So the directory is created here, EMPTY, and never committed. That matters — whatever is in the
# output directory is published as static files. The tempting one-line fix is
# `"outputDirectory": "."`, which would serve this entire directory: schema.prisma, every adapter,
# core/, and anything a future contributor drops beside them. `check-server-config.mjs` row V11
# refuses that value by name so it cannot be reintroduced as a quick fix during an outage.
mkdir -p public

npx prisma generate

if [ "${VERCEL_ENV:-}" = "production" ] || [ "${LZP_PREVIEW_DB_IS_ISOLATED:-}" = "true" ]; then
  npx prisma migrate deploy
else
  echo "SKIPPING prisma migrate deploy: this is a preview and LZP_PREVIEW_DB_IS_ISOLATED is not true. See docs/v2/RELEASE.md."
fi
