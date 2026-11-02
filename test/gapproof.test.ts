import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  callGapproofTool,
  extractFunctions,
  extractTestCases,
  VERSION,
} from "../src/gapproof.js";
import type { DirEntryLike, FsDeps } from "../src/types.js";

const NOW = "2026-10-26T00:00:00.000Z";

const FILES: Record<string, string> = {
  "/repo/package.json": "{}",
  "/repo/README.md": "# fixture\n",
  "/repo/src/math.ts": [
    "// REQ-101 addition helpers",
    "export function add(a: number, b: number) { return a + b; }",
    "export const multiply = (a: number, b: number) => a * b;",
    "function helper() { return 1; }",
    "export function unusedExport() { return 0; }",
    "",
  ].join("\n"),
  "/repo/src/util.py": [
    "# UTIL-7 utilities",
    "def slugify(text):",
    "    return text.lower()",
    "def _private():",
    "    pass",
    "",
  ].join("\n"),
  "/repo/test/math.test.ts": [
    'import { add } from "../src/math";',
    'it("adds numbers", () => { add(1, 2); });',
    'it("multiplies", () => { multiply(2, 3); });',
    "",
  ].join("\n"),
  "/repo/tests/test_util.py": [
    "from util import slugify",
    "def test_slugify():",
    '    assert slugify("Hi")',
    "",
  ].join("\n"),
  // Everything below must be skipped by the walk.
  "/repo/node_modules/evil.ts": "export function evil() { return 0; }",
  "/repo/dist/out.ts": "export function distFn() { return 0; }",
  "/repo/.hidden/x.ts": "export function hiddenFn() { return 0; }",
};

function entry(name: string, dir: boolean): DirEntryLike {
  return { name, isDirectory: () => dir, isFile: () => !dir };
}

function memoryDeps(): { deps: FsDeps; written: Map<string, string> } {
  const written = new Map<string, string>();
  const all = () => new Map([...Object.entries(FILES), ...written]);
  const deps: FsDeps = {
    readFile: async (path) => {
      const value = all().get(path);
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    readdir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const children = new Map<string, boolean>();
      for (const key of all().keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const [first, ...more] = rest.split("/");
        children.set(first, more.length > 0);
      }
      if (children.size === 0) throw new Error(`ENOENT: ${path}`);
      return [...children.entries()].map(([name, dir]) => entry(name, dir));
    },
    writeFile: async (path, data) => {
      written.set(path, data);
    },
    mkdir: async () => {},
    now: () => NOW,
  };
  return { deps, written };
}

const call = (deps: FsDeps, tool: string, args: Record<string, unknown>) =>
  callGapproofTool(deps, tool, args);

describe("extraction heuristics", () => {
  it("extracts TS/JS and Python functions with exported flags", () => {
    const ts = extractFunctions("a.ts", FILES["/repo/src/math.ts"]);
    assert.deepEqual(
      ts.map((f) => [f.name, f.exported]),
      [
        ["add", true],
        ["multiply", true],
        ["helper", false],
        ["unusedExport", true],
      ],
    );
    const py = extractFunctions("u.py", FILES["/repo/src/util.py"]);
    assert.deepEqual(
      py.map((f) => [f.name, f.exported]),
      [
        ["slugify", true],
        ["_private", false],
      ],
    );
    assert.deepEqual(extractTestCases("t.test.ts", FILES["/repo/test/math.test.ts"]), [
      "adds numbers",
      "multiplies",
    ]);
    assert.deepEqual(extractTestCases("test_u.py", FILES["/repo/tests/test_util.py"]), [
      "test_slugify",
    ]);
    assert.equal(VERSION, "0.1.0");
  });
});

describe("analysis tools", () => {
  it("start analyzes, persists graph.json, and returns summary counts", async () => {
    const { deps, written } = memoryDeps();
    const result = await call(deps, "orangepro_start", { root: "/repo" });
    assert.deepEqual(result, {
      root: "/repo",
      sources: 2,
      functions: 6,
      tests: 3,
      linked: 3,
      unlinked: 3,
    });
    const raw = written.get("/repo/.gapproof/graph.json");
    assert.ok(raw, "graph.json was written");
    const graph = JSON.parse(raw);
    assert.equal(graph.generated_at, NOW);
    assert.deepEqual(graph.runs, []);
    assert.deepEqual(graph.test_files, ["test/math.test.ts", "tests/test_util.py"]);
  });

  it("analyze_sources lists per-file functions without persisting", async () => {
    const { deps, written } = memoryDeps();
    const result = (await call(deps, "orangepro_analyze_sources", { root: "/repo" })) as {
      sources: { file: string; functions: string[] }[];
      functions: number;
    };
    assert.deepEqual(result.sources, [
      { file: "src/math.ts", functions: ["add", "multiply", "helper", "unusedExport"] },
      { file: "src/util.py", functions: ["slugify", "_private"] },
    ]);
    assert.equal(result.functions, 6);
    assert.equal(written.size, 0);
  });

  it("find_test_gaps ranks exported first, then file order, and honours limit", async () => {
    const { deps } = memoryDeps();
    const gaps = await call(deps, "orangepro_find_test_gaps", { root: "/repo" });
    assert.deepEqual(gaps, [
      { function: "unusedExport", file: "src/math.ts", exported: true },
      { function: "helper", file: "src/math.ts", exported: false },
      { function: "_private", file: "src/util.py", exported: false },
    ]);
    const limited = await call(deps, "orangepro_find_test_gaps", { root: "/repo", limit: 1 });
    assert.deepEqual(limited, [
      { function: "unusedExport", file: "src/math.ts", exported: true },
    ]);
  });

  it("status reports a fresh snapshot before start and stored counts after", async () => {
    const { deps } = memoryDeps();
    const before = (await call(deps, "orangepro_status", { root: "/repo" })) as {
      exists: boolean;
      functions: number;
      linked: number;
    };
    assert.equal(before.exists, false);
    assert.equal(before.functions, 6);
    assert.equal(before.linked, 3);
    await call(deps, "orangepro_start", { root: "/repo" });
    const after = (await call(deps, "orangepro_status", { root: "/repo" })) as {
      exists: boolean;
      generated_at: string;
      counts: { functions: number; runs: number };
    };
    assert.equal(after.exists, true);
    assert.equal(after.generated_at, NOW);
    assert.equal(after.counts.functions, 6);
    assert.equal(after.counts.runs, 0);
  });

  it("doctor checks layout and a missing root", async () => {
    const { deps } = memoryDeps();
    assert.deepEqual(await call(deps, "orangepro_doctor", { root: "/repo" }), {
      root_exists: true,
      has_manifest: true,
      source_files: 2,
      test_files: 2,
      issues: [],
    });
    const missing = (await call(deps, "orangepro_doctor", { root: "/nope" })) as {
      root_exists: boolean;
      issues: string[];
    };
    assert.equal(missing.root_exists, false);
    assert.equal(missing.issues.length, 1);
  });

  it("stats and graph_score reflect linked and proven ratios", async () => {
    const { deps } = memoryDeps();
    assert.deepEqual(await call(deps, "orangepro_stats", { root: "/repo" }), {
      files: 4,
      functions: 6,
      tests: 3,
      test_files: 2,
      linked: 3,
      unlinked: 3,
      proven: 0,
      runs: 0,
    });
    assert.deepEqual(await call(deps, "orangepro_graph_score", { root: "/repo" }), {
      score: 30,
      linked_ratio: 0.5,
      proven_ratio: 0,
      functions: 6,
    });
  });

  it("rtm extracts requirement ids from source comments only", async () => {
    const { deps } = memoryDeps();
    assert.deepEqual(await call(deps, "orangepro_rtm", { root: "/repo" }), [
      {
        id: "REQ-101",
        functions: ["add", "multiply", "helper", "unusedExport"],
        covered: false,
      },
      { id: "UTIL-7", functions: ["slugify", "_private"], covered: false },
    ]);
  });

  it("changed_impact maps changed files to functions and affected tests", async () => {
    const { deps } = memoryDeps();
    assert.deepEqual(
      await call(deps, "orangepro_changed_impact", { root: "/repo", files: ["src/math.ts"] }),
      {
        changed_functions: ["add", "multiply", "helper", "unusedExport"],
        affected_tests: ["test/math.test.ts"],
        unlinked_changed: ["helper", "unusedExport"],
      },
    );
    assert.deepEqual(
      await call(deps, "orangepro_changed_impact", {
        root: "/repo",
        files: ["./src/util.py"],
      }),
      {
        changed_functions: ["slugify", "_private"],
        affected_tests: ["tests/test_util.py"],
        unlinked_changed: ["_private"],
      },
    );
  });
});

describe("recorded runs and proven functions", () => {
  it("record_run creates the graph when needed and appends runs", async () => {
    const { deps, written } = memoryDeps();
    assert.deepEqual(
      await call(deps, "orangepro_record_run", {
        root: "/repo",
        test: "math.test",
        outcome: "pass",
      }),
      { recorded: true, runs_total: 1 },
    );
    assert.ok(written.get("/repo/.gapproof/graph.json"));
    // A passing run naming the test file proves its linked functions.
    const stats = (await call(deps, "orangepro_stats", { root: "/repo" })) as {
      proven: number;
      runs: number;
    };
    assert.deepEqual(stats, {
      files: 4,
      functions: 6,
      tests: 3,
      test_files: 2,
      linked: 3,
      unlinked: 3,
      proven: 2,
      runs: 1,
    });
    // A passing run naming a function directly proves that function.
    await call(deps, "orangepro_record_run", {
      root: "/repo",
      test: "manual",
      outcome: "pass",
      functions: ["slugify"],
    });
    // A failing run proves nothing.
    await call(deps, "orangepro_record_run", {
      root: "/repo",
      test: "manual",
      outcome: "fail",
      functions: ["helper"],
    });
    const after = (await call(deps, "orangepro_stats", { root: "/repo" })) as {
      proven: number;
      runs: number;
    };
    assert.equal(after.proven, 3);
    assert.equal(after.runs, 3);
    const score = (await call(deps, "orangepro_graph_score", { root: "/repo" })) as {
      score: number;
    };
    assert.equal(score.score, 50);
  });

  it("explain_test locates a test file and splits linked vs proven", async () => {
    const { deps } = memoryDeps();
    await call(deps, "orangepro_record_run", {
      root: "/repo",
      test: "math.test",
      outcome: "pass",
    });
    const explained = (await call(deps, "orangepro_explain_test", {
      root: "/repo",
      test: "math.test",
    })) as {
      file: string;
      linked_functions: string[];
      proven_functions: string[];
      content_excerpt: string;
    };
    assert.equal(explained.file, "test/math.test.ts");
    assert.deepEqual(explained.linked_functions, ["add", "multiply"]);
    assert.deepEqual(explained.proven_functions, ["add", "multiply"]);
    assert.ok(explained.content_excerpt.startsWith('import { add }'));
    assert.ok(explained.content_excerpt.length <= 400);
    await assert.rejects(
      call(deps, "orangepro_explain_test", { root: "/repo", test: "nope" }),
      /test not found/,
    );
  });

  it("export_evidence_pack returns score, stats, gaps, and runs without writing", async () => {
    const { deps, written } = memoryDeps();
    const pack = (await call(deps, "orangepro_export_evidence_pack", { root: "/repo" })) as {
      generated_at: string;
      score: number;
      gaps: unknown[];
      runs: unknown[];
    };
    assert.equal(pack.generated_at, NOW);
    assert.equal(pack.score, 30);
    assert.equal(pack.gaps.length, 3);
    assert.deepEqual(pack.runs, []);
    assert.equal(written.size, 0);
  });
});

describe("validation", () => {
  it("rejects unknown tools, bad outcomes, and missing roots", async () => {
    const { deps } = memoryDeps();
    await assert.rejects(call(deps, "orangepro_nope", { root: "/repo" }), /Unknown tool/);
    await assert.rejects(
      call(deps, "orangepro_record_run", { root: "/repo", test: "t", outcome: "skip" }),
      /outcome must be/,
    );
    await assert.rejects(call(deps, "orangepro_stats", { root: "" }), /root must be/);
    await assert.rejects(call(deps, "orangepro_stats", { root: "/missing" }), /cannot read/);
  });
});
