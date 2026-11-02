# gapproof — Build Report

Tranche #101+ Batch 2, MCP Rebuild 1000 program. Clean-room rebuild
of OrangeproAI/orangepro-mcp (rank 65, 18 stars), built from its
public README tool spec retrieved 2026-10-26/27. **Labelled core
subset: 12 of the 18 documented tools.** The original is a LOCAL
Tier A repo-analysis tool (no network; a model key is optional in
the original only for AI test generation, which this subset omits).
Local build only — nothing pushed or published.

Identity: repo `gapproof`, npm `@reneturcios/gapproof`, MCP name
`io.github.CloudCorpRecords/gapproof`, version `0.1.0`.
Build dir: `~/workspace/mcp-rebuild-100/builds/gapproof/`

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `gapproof: dist/cli.js`, `mcpName` set,
  scripts build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Find untested functions: link tests
  to code, score coverage, record proven runs locally." = **88
  chars** (≤100 ✓, counted programmatically); npm entry carries
  `version: 0.1.0`; OCI entry `ghcr.io/cloudcorprecords/gapproof:0.1.0`
  carries **no** `version` field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT
  `node /app/dist/cli.js`, CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/gapproof"`
- `tsconfig.json` (318 bytes, fleet-identical), `.gitignore`,
  `package-lock.json` (see Lockfile), `LICENSE` (MIT, Copyright (c)
  2026 Rene Turcios), `README.md` (fresh text), `CHANGELOG.md`
  (single 0.1.0 entry, 2026-10-26)
- `src/index.ts`, `src/cli.ts` (one subcommand per tool taking a JSON
  argument object, plus `mcp` and `--version`; unknown command exits
  2), `src/mcp.ts`, `src/types.ts`, `src/gapproof.ts` (core,
  `VERSION = "0.1.0"`)
- `test/gapproof.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (mechanics copied from textgraph; image/server name changed to gapproof)

## Fixture first

`~/workspace/mcp-rebuild-100/harness/fixtures/orangepro-mcp-tools-original.json`
was written before the build, with `_source`: "docs-derived core
subset (12 of the 18 tools in the OrangeproAI/orangepro-mcp README,
retrieved 2026-10-26). Omitted: orangepro_prove_loop, orangepro_prove,
orangepro_generate_tests, orangepro_update_graph, orangepro_ai_links,
orangepro_ai_flows (proof-execution and AI-assisted tools; the
original's AI flows need a model key). Schemas are
documented-parameter reconstructions (README gives purposes, not wire
schemas). Parity is against this subset only." In the fixture,
`orangepro_record_run`'s `outcome` is type `string`; the
`"pass" | "fail"` enum lives only in the zod validation layer.

## Implementation notes

- `src/mcp.ts` uses the SDK's low-level `Server` with explicit schema
  literals exactly as in the fixture (NOT `McpServer` + zod), so
  `tools/list` matches the spec exactly; zod still validates every
  `tools/call` argument set. Tool names keep the documented
  `orangepro_*` names verbatim.
- Repo model: walk the root (skipping `node_modules`, `.git`,
  `dist`, dot-dirs); `.ts/.tsx/.js/.jsx/.py` files under `test/`,
  `tests/`, `__tests__/` or named `*.test.*` / `*.spec.*` /
  `test_*.py` / `*_test.py` are test files, the rest are sources.
- Function extraction is regex-only: TS/JS `function name(`,
  `export function name(`, `const name = (...) =>` (plus let/var,
  `function`-value and `async` variants); Python `def name(` (a name
  not starting with `_` counts as exported).
- Linking: a function name appearing as a word in a test file's
  content = linked. Proving: a recorded run with outcome `pass`
  naming the function, or naming a test file / test case that links
  it = proven. Score = 60% linked ratio + 40% proven ratio.
- Filesystem sits behind injectable deps (`readFile` / `readdir` /
  `writeFile` / optional `mkdir` + a `now()` clock); the default is
  `node:fs/promises`. Tests run against an in-memory fixture repo
  with a fixed clock. State file: `<root>/.gapproof/graph.json`.
- `orangepro_start` persists the graph (preserving recorded runs);
  `orangepro_record_run` appends a run, running a fresh analysis
  first when no graph exists; `orangepro_status` returns stored
  counts or `{exists: false}` plus a fresh unstored snapshot;
  `orangepro_export_evidence_pack` returns its pack without writing.
- RTM: ids matching `[A-Z]+-\d+` are read from source comments only
  and associated with the functions of the same file; `covered`
  means every associated function is linked.

## Verification (exact foreground outputs)

### 1. Build
```
$ ./node_modules/.bin/tsc && echo TSC_OK
TSC_OK (exit 0; dist/ produced: cli, gapproof, index, mcp, types)
```

### 2. Tests (in-memory fixture repo, no disk, no network)
```
$ ./node_modules/.bin/tsx --test test/*.test.ts
tests 13 / pass 13 / fail 0
```
Covers: TS + Python extraction with exported flags, test-case
extraction, walk skipping (node_modules/dist/dot-dirs planted in the
fixture), start persistence + summary counts, per-file source lists
without persisting, gap ranking (exported first, then file order)
and `limit`, status before/after start, doctor on a good and a
missing root, stats + score (linked 3/6, proven 0 → score 30), RTM
ids (`REQ-101`, `UTIL-7`, uncovered), changed-impact for TS and
Python files, record_run creating the graph when needed, proof by
test-file name and by direct function name, failing runs proving
nothing (proven 3/6 → score 50), explain_test linked vs proven and
its not-found error, evidence pack returning without writing, and
validation errors (unknown tool, bad outcome, missing root).

### 3. Parity
```
$ python3 ~/workspace/mcp-rebuild-100/harness/parity.py \
    --original ~/workspace/mcp-rebuild-100/harness/fixtures/orangepro-mcp-tools-original.json \
    --rebuild "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/gapproof/dist/cli.js mcp" \
    --out ~/workspace/mcp-rebuild-100/builds/gapproof/parity-out
verdict=PASS parity_pct=100.0 original_tools=12 rebuild_tools=12 missing=[] extra=[] schema_diffs=[]
(exit 0)
```

### 4. Honest check (real CLI, tiny fixture repo in /tmp via file tools)

Fixture: `/tmp/gapproof-fixture/` — 2 source files (`src/a.ts`:
`greet`, `shout`, `internal`; `src/b.py`: `slugify`, `_cache_key`),
1 test file (`test/a.test.ts` with 2 `it(...)` cases mentioning
`greet` and `slugify`), plus a `package.json`.

```
$ node dist/cli.js --version
0.1.0

$ node dist/cli.js orangepro_start '{"root":"/tmp/gapproof-fixture"}'
{
  "root": "/tmp/gapproof-fixture",
  "sources": 2,
  "functions": 5,
  "tests": 2,
  "linked": 2,
  "unlinked": 3
}

$ node dist/cli.js orangepro_find_test_gaps '{"root":"/tmp/gapproof-fixture"}'
[
  { "function": "shout",      "file": "src/a.ts", "exported": true },
  { "function": "internal",   "file": "src/a.ts", "exported": false },
  { "function": "_cache_key", "file": "src/b.py", "exported": false }
]

$ node dist/cli.js orangepro_status '{"root":"/tmp/gapproof-fixture"}'
{ "exists": true, "generated_at": "2026-10-27T04:41:07.068Z",
  "counts": { "sources": 2, "functions": 5, "tests": 2, "test_files": 1,
              "linked": 2, "unlinked": 3, "proven": 0, "runs": 0 } }

$ node dist/cli.js bogus_tool '{}'   →  Usage on stderr, exit 2
```
The persisted graph really landed at
`/tmp/gapproof-fixture/.gapproof/graph.json` (status read it back).

## Lockfile status

**Clean lockfile (Route 3), verified.** `package.json` alone was
copied into a fresh `/tmp/gapproof-lock/` (no `node_modules` there)
and `npm install --package-lock-only --ignore-scripts --offline`
produced a `package-lock.json` that parses, has
`name == "@reneturcios/gapproof"`, lockfileVersion 3, and **128
package entries**; that file was copied into the build dir.
`node_modules` in the build dir is a `cp -a` copy from clockport
(local build only, gitignored; the copy logged the usual
ownership-preservation warnings but the tree verifies — `tsc` and
`tsx` run from it).

## Gaps

- **Regex heuristics, no AST.** Function extraction only sees the
  documented declaration shapes; computed, re-exported, or
  dynamically defined functions are missed, and a coincidental word
  match in a test file counts as a link.
- **Omitted tools (core subset):** `orangepro_prove_loop`,
  `orangepro_prove`, `orangepro_generate_tests`,
  `orangepro_update_graph`, `orangepro_ai_links`,
  `orangepro_ai_flows` — the proof-execution and AI-assisted tools;
  the original's AI flows need a model key.
- **RTM only sees comment ids.** Requirement ids in strings, docs,
  or issue trackers are invisible to it, and association is
  whole-file, not per-function.
- **Schemas are documented-parameter reconstructions** (the README
  gives purposes, not wire schemas), and **the original server was
  never run** — parity is against the docs-derived fixture subset
  only.
- Container build not exercised locally; the publish-container
  workflow smoke-tests the image at publish time.

## Blockers

None for the local build. Nothing pushed or published;
SCOREBOARD/NAMES were not edited.
