# Releasing

Publishing is always a manual, maintainer-approved step.

1. Update `version` in `package.json`, `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`;
   update `CHANGELOG.md` and the EOL table date in `src/rules/supply-chain.ts` if needed.
2. `npm run build && npm run ci && node scripts/smoke-install.mjs && node scripts/bench.mjs`.
3. `node plugin/dist/relivaro.mjs release . --allow-exec --online` must report no blockers; update
   `docs/RELEASE_READINESS.md`.
4. Commit, then run the **Release** workflow (`workflow_dispatch`, input `tag: vX.Y.Z`). It re-runs CI and the
   clean-install test and creates a **draft** GitHub release with the npm tarball.
5. After review: publish the draft release, then `npm publish` from a clean checkout of the tag (with 2FA). The
   plugin marketplace picks up the tagged repository.
