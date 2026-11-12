# Benchmarks

Measured 2026-11-01 with Relivaro 1.1.0 on Apple M4 (10 cores, 16 GB), darwin/arm64, Node v22.23.2. Raw data: [bench/results/latest.json](../bench/results/latest.json). Reproduce with `node scripts/bench.mjs` (CI runs it on every push).

## Detection accuracy (fixture corpus)

The corpus annotates every expected finding inline; anything else Relivaro reports is a false positive. The benchmark fails below 95% precision or recall.

| Fixture | TP | FP | FN | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| clean-service | 0 | 0 | 0 | 100% | 100% |
| laravel-app | 40 | 0 | 0 | 100% | 100% |
| misc-rules | 14 | 0 | 0 | 100% | 100% |
| monorepo-docker | 1 | 0 | 0 | 100% | 100% |
| monorepo-lib | 1 | 0 | 0 | 100% | 100% |
| next-app | 12 | 0 | 0 | 100% | 100% |
| node-api | 72 | 0 | 0 | 100% | 100% |
| python-app | 33 | 0 | 0 | 100% | 100% |
| regressions | 5 | 0 | 0 | 100% | 100% |
| sql-migrations | 4 | 0 | 0 | 100% | 100% |
| static-site | 3 | 0 | 0 | 100% | 100% |
| **total** | **185** | **0** | **0** | **100.0%** | **100.0%** |

Detection accuracy re-measured 2026-11-12 with Relivaro 1.6.0. 85 rule ids appear in the corpus. Corpus accuracy is a regression guard, not a claim about accuracy on arbitrary code; see [VALIDATION.md](VALIDATION.md) for real-world review.

## Analysis performance

Full `audit` (all categories, offline), wall time and peak RSS of the whole process.

| Target | Files | Lines | Parsed files | Time | Throughput | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- |
| Synthetic (60 units, JS/PHP/Python) | 3,060 | 48,600 | 3000 | 1.39 s (median of 3) | 2,207 files/s · 35,045 lines/s | 129 MB |
| repo-1 (Flutter, Riverpod, go_router, Filament, Laravel) | 4,873 | 241,383 | 563 | 2.93–3.21 s (3 runs) | 1,520–1,660 files/s | 208 MB |
| repo-2 (Next.js, React) | 114 | 5,892 | 62 | 0.32 s | 353 files/s | 129 MB |
| repo-3 (Astro, Flutter, go_router, Laravel, Livewire, Filament) | 421 | 18,525 | 128 | 0.98 s | 431 files/s | 146 MB |
| repo-4 (Next.js, React, Electron, Django, Flutter, Tokio) | 1,065 | 23,628 | 125 | 1.39 s | 766 files/s | 177 MB |
| repo-5 (Astro, Laravel, Next.js, React) | 380 | 13,246 | 105 | 0.99 s | 385 files/s | 152 MB |

Repositories 2–5 were last measured with 1.0.0; 1.1.0 did not change the analysis path. Throughput doubled in v1.0 development after profiling showed per-rule tree traversals crossing the WASM boundary dominated: a shared per-tree node index (released after each file) and secret-pattern prefilters cut repo-1 from 7.7 s to 3.3 s with identical findings.

## Notes

- Times include process start, git file listing, tree-sitter WASM initialisation, discovery and all rules.
- Execution checks (`--allow-exec`) and OSV lookups (`--online`) are excluded; their cost is dominated by the project's own tests/build and network latency.
- `relivaro bench` / `relivaro load` measure *your* software; see [CLI.md](CLI.md).
