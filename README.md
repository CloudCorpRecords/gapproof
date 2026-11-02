# gapproof

gapproof is a local test-gap analysis tool for a code repository. It
walks the sources, extracts the functions it finds, checks which of
them are mentioned by a test, and reports the gaps: functions no test
appears to cover. Recorded test runs add a second, stronger signal —
a function named by a passing run (directly, or through the test that
links it) counts as *proven*, not just linked — and the two signals
combine into a single coverage score.

This package is a clean-room rebuild, and a **labelled core subset**:
it covers 12 of the 18 tools documented for the original Orangepro
MCP server (`orangepro_*`). The omitted tools are listed under
"Scope" below.

## How it works — honestly

There is no AST, no parser, and no network call anywhere. The engine
is a set of documented heuristics:

- **Walk.** Starting at the given root, it skips `node_modules`,
  `.git`, `dist`, and dot-directories. Files ending in `.ts`, `.tsx`,
  `.js`, `.jsx`, or `.py` are classified as tests when they live under
  `test/`, `tests/`, or `__tests__/`, or are named `*.test.*`,
  `*.spec.*`, `test_*.py`, or `*_test.py`; all others are sources.
- **Extraction (regex).** TypeScript/JavaScript: `function name(`,
  `export function name(`, and `const name = (...) =>` (also
  `let`/`var`, the `function` keyword form, and an optional `async`).
  Python: `def name(`. A Python name not starting with `_` counts as
  exported; a TS/JS name counts as exported when declared with
  `export`.
- **Linking.** A function is *linked* when its name appears as a word
  in some test file's content.
- **Proving.** `orangepro_record_run` appends a run
  (`test`, `outcome: "pass" | "fail"`, optional `functions`) to the
  persisted graph. A function is *proven* when a passing run names
  the function, or names a test file / test case that links it.
- **Score.** `60% × linked ratio + 40% × proven ratio`, reported on
  a 0–100 scale with one decimal place.
- **RTM.** Requirement ids matching `[A-Z]+-\d+` are read from source
  *comments only* (`//`, `/* … */`, `#`) and associated with the
  functions defined in the same file.

State lives in one file: `<root>/.gapproof/graph.json`, written by
`orangepro_start` and `orangepro_record_run`. Everything else reads
the repository (and that graph, when runs matter) without writing.

## Install

```bash
npx @reneturcios/gapproof orangepro_start '{"root":"/path/to/repo"}'
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/gapproof
```

The container defaults to the MCP server. Pass CLI arguments to use
it as a CLI instead. No API key is needed — the original's optional
model key only powers its AI test-generation tools, which this
subset omits.

## CLI

The CLI mirrors the tools: one subcommand per tool, taking its
arguments as a single JSON object.

```bash
gapproof orangepro_start '{"root":"/path/to/repo"}'
gapproof orangepro_analyze_sources '{"root":"/path/to/repo"}'
gapproof orangepro_find_test_gaps '{"root":"/path/to/repo","limit":10}'
gapproof orangepro_status '{"root":"/path/to/repo"}'
gapproof orangepro_record_run '{"root":"/path/to/repo","test":"math.test","outcome":"pass"}'
gapproof orangepro_export_evidence_pack '{"root":"/path/to/repo"}'
gapproof --version
```

Exit codes: `0` on success, `1` on an analysis or validation error,
`2` for usage errors.

## MCP server

One bin serves both faces. The `mcp` subcommand starts a stdio MCP
server:

```bash
npx -y @reneturcios/gapproof mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "gapproof": {
      "command": "npx",
      "args": ["-y", "@reneturcios/gapproof", "mcp"]
    }
  }
}
```

### Tools

All tools take `root` (the repository path) unless noted.

| Tool | Extra input | What it returns |
| --- | --- | --- |
| `orangepro_start` | — | Analyzes the repo, persists `.gapproof/graph.json` (preserving recorded runs), and returns `{root, sources, functions, tests, linked, unlinked}` counts. |
| `orangepro_analyze_sources` | — | The same walk without persisting: per-file function lists plus the total function count. |
| `orangepro_find_test_gaps` | `limit` (optional) | Unlinked functions as `[{function, file, exported}]`, exported first, then in file order. |
| `orangepro_status` | — | With a persisted graph: `{exists: true, generated_at, counts}`. Without one: `{exists: false}` plus a fresh, unstored snapshot. |
| `orangepro_doctor` | — | `{root_exists, has_manifest, source_files, test_files, issues}`; a manifest is `package.json` or `pyproject.toml` at the root. |
| `orangepro_graph_score` | — | `{score, linked_ratio, proven_ratio, functions}` — 60% linked + 40% proven. |
| `orangepro_stats` | — | `{files, functions, tests, test_files, linked, unlinked, proven, runs}`. `tests` counts individual test cases; `test_files` counts files. |
| `orangepro_rtm` | — | `[{id, functions, covered}]` for requirement ids found in source comments; `covered` means every associated function is linked. Empty when no ids appear. |
| `orangepro_changed_impact` | `files` (required array) | `{changed_functions, affected_tests, unlinked_changed}` for the given repo-relative changed files. |
| `orangepro_record_run` | `test`, `outcome` (required), `functions` (optional) | Appends a run to the graph (running a fresh analysis first when no graph exists) and returns `{recorded: true, runs_total}`. |
| `orangepro_explain_test` | `test` (required) | Locates a test file by name substring and returns `{test, file, linked_functions, proven_functions, content_excerpt}` (excerpt ≤ 400 chars). |
| `orangepro_export_evidence_pack` | — | `{generated_at, root, score, stats, gaps, runs}`, returned to the caller — nothing is written. |

## Scope

Omitted from this core subset: `orangepro_prove_loop`,
`orangepro_prove`, `orangepro_generate_tests`,
`orangepro_update_graph`, `orangepro_ai_links`, and
`orangepro_ai_flows`. Those are the original's proof-execution and
AI-assisted tools; the AI flows need a model key in the original.
This subset reproduces the local analysis surface only, with the
heuristic limits stated above: name-based linking can miss indirect
coverage and can credit a coincidental mention, and comment-based
RTM extraction only sees ids written in comments.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node test runner over test/*.test.ts, in-memory fixture repo, no network, no disk
npm run dev     # run the CLI from source via tsx
```

## License

MIT — see `LICENSE`.
