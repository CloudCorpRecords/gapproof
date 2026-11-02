/**
 * gapproof core: a local, static test-gap analysis engine.
 *
 * Clean-room rebuild of the core subset of OrangeproAI/orangepro-mcp,
 * from its public README tool list. The engine is deliberately honest
 * and simple, and says so wherever a heuristic replaces real analysis:
 *
 * - It walks a repository root (skipping node_modules, .git, dist and
 *   dot-directories), classifying .ts/.tsx/.js/.jsx/.py files as
 *   sources or tests by location and name.
 * - Functions are extracted with line regexes (`function name(`,
 *   `const name = (...) =>`, `export function name(`, Python
 *   `def name(`) — there is no AST and no parsing.
 * - A function is "linked" when its name appears as a word in some
 *   test file's content. A function is "proven" when a recorded run
 *   with outcome "pass" names the function, or names a test (file or
 *   test case) that links it.
 * - State is one JSON file, <root>/.gapproof/graph.json.
 *
 * All filesystem access goes through injectable FsDeps and every
 * timestamp comes from the injected clock, so tests run entirely
 * against an in-memory fixture repo. No network is used anywhere.
 */
import { readdir as fsReaddir, readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir } from "node:fs/promises";
import type {
  ChangedImpactArgs,
  DirEntryLike,
  ExplainTestArgs,
  FindTestGapsArgs,
  FsDeps,
  FunctionInfo,
  GraphFile,
  RecordRunArgs,
  RootArgs,
  RunRecord,
  SourceFileInfo,
  TestLink,
} from "./types.js";

export const VERSION = "0.1.0";

export const TOOL_NAMES = [
  "orangepro_start",
  "orangepro_analyze_sources",
  "orangepro_find_test_gaps",
  "orangepro_status",
  "orangepro_doctor",
  "orangepro_graph_score",
  "orangepro_stats",
  "orangepro_rtm",
  "orangepro_changed_impact",
  "orangepro_record_run",
  "orangepro_explain_test",
  "orangepro_export_evidence_pack",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/** Default deps backed by node:fs/promises and the real clock. */
export function defaultDeps(): FsDeps {
  return {
    readFile: (path) => fsReadFile(path, "utf8"),
    readdir: async (path) => (await fsReaddir(path, { withFileTypes: true })) as DirEntryLike[],
    writeFile: (path, data) => fsWriteFile(path, data, "utf8"),
    mkdir: async (path) => {
      await fsMkdir(path, { recursive: true });
    },
    now: () => new Date().toISOString(),
  };
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  return base.endsWith("/") ? base + rel : `${base}/${rel}`;
}

function graphPath(root: string): string {
  return joinPath(joinPath(root, ".gapproof"), "graph.json");
}

function requireRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("root must be a non-empty string");
  }
  const root = value.trim();
  return root.length > 1 ? root.replace(/\/+$/, "") : root;
}

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".py"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

function isTestFile(rel: string): boolean {
  const segments = rel.split("/");
  const base = segments[segments.length - 1];
  if (segments.some((s) => s === "test" || s === "tests" || s === "__tests__")) return true;
  if (/\.test\.[^.]+$/.test(base) || /\.spec\.[^.]+$/.test(base)) return true;
  if (base.startsWith("test_") && base.endsWith(".py")) return true;
  if (base.endsWith("_test.py")) return true;
  return false;
}

function hasSourceExt(rel: string): boolean {
  const lower = rel.toLowerCase();
  return SOURCE_EXTS.some((ext) => lower.endsWith(ext));
}

/** Extract function definitions from one file's content (regex heuristics). */
export function extractFunctions(rel: string, content: string): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  const isPy = rel.endsWith(".py");
  for (const line of content.split(/\r?\n/)) {
    if (isPy) {
      const m = /^\s*def\s+([A-Za-z_][\w]*)\s*\(/.exec(line);
      if (m) out.push({ name: m[1], file: rel, exported: !m[1].startsWith("_") });
      continue;
    }
    let m = /^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) {
      out.push({ name: m[1], file: rel, exported: true });
      continue;
    }
    m = /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.exec(line);
    if (m) {
      out.push({ name: m[1], file: rel, exported: true });
      continue;
    }
    m = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (m) {
      out.push({ name: m[1], file: rel, exported: false });
      continue;
    }
    m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.exec(line);
    if (m) out.push({ name: m[1], file: rel, exported: false });
  }
  return out;
}

/** Test-case names declared in one test file (it/test calls, or def test_*). */
export function extractTestCases(rel: string, content: string): string[] {
  const names: string[] = [];
  if (rel.endsWith(".py")) {
    for (const m of content.matchAll(/^\s*def\s+(test_[\w]*)\s*\(/gm)) names.push(m[1]);
    return names;
  }
  for (const m of content.matchAll(/\b(?:it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g)) names.push(m[1]);
  return names;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentions(content: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`).test(content);
}

export interface Analysis {
  root: string;
  sources: SourceFileInfo[];
  functions: FunctionInfo[];
  testFiles: string[];
  tests: number;
  testLinks: TestLink[];
  sourceContents: Map<string, string>;
  testContents: Map<string, string>;
  linkedIndexes: Set<number>;
}

async function walk(
  deps: FsDeps,
  dirAbs: string,
  relBase: string,
  out: string[],
): Promise<void> {
  const entries = [...(await deps.readdir(dirAbs))].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await walk(deps, joinPath(dirAbs, entry.name), rel, out);
    } else if (entry.isFile() && hasSourceExt(entry.name)) {
      out.push(rel);
    }
  }
}

/** Walk and analyze a repository without persisting anything. */
export async function analyzeRepo(deps: FsDeps, rootInput: unknown): Promise<Analysis> {
  const root = requireRoot(rootInput);
  const relFiles: string[] = [];
  try {
    await walk(deps, root, "", relFiles);
  } catch (err) {
    throw new Error(
      `cannot read repository root '${root}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const sources: SourceFileInfo[] = [];
  const functions: FunctionInfo[] = [];
  const testFiles: string[] = [];
  const testLinks: TestLink[] = [];
  const sourceContents = new Map<string, string>();
  const testContents = new Map<string, string>();
  let tests = 0;
  for (const rel of relFiles) {
    const content = await deps.readFile(joinPath(root, rel));
    if (isTestFile(rel)) {
      testFiles.push(rel);
      testContents.set(rel, content);
      tests += extractTestCases(rel, content).length;
    } else {
      const fns = extractFunctions(rel, content);
      sources.push({ file: rel, functions: fns.map((f) => f.name) });
      functions.push(...fns);
      sourceContents.set(rel, content);
    }
  }
  for (const rel of testFiles) {
    const content = testContents.get(rel) ?? "";
    const linked = functions.filter((f) => mentions(content, f.name)).map((f) => f.name);
    testLinks.push({ file: rel, functions: [...new Set(linked)], tests: extractTestCases(rel, content) });
  }
  const linkedIndexes = new Set<number>();
  functions.forEach((f, i) => {
    if (testLinks.some((l) => l.functions.includes(f.name))) linkedIndexes.add(i);
  });
  return {
    root,
    sources,
    functions,
    testFiles,
    tests,
    testLinks,
    sourceContents,
    testContents,
    linkedIndexes,
  };
}

/** Indexes of functions proven by passing runs, given link information. */
export function provenIndexes(
  functions: FunctionInfo[],
  testLinks: TestLink[],
  runs: RunRecord[],
): Set<number> {
  const proven = new Set<number>();
  for (const run of runs) {
    if (run.outcome !== "pass") continue;
    functions.forEach((f, i) => {
      if (run.functions?.includes(f.name)) proven.add(i);
      const namingLink = testLinks.some(
        (l) =>
          l.functions.includes(f.name) &&
          (l.file === run.test || l.file.includes(run.test) || (l.tests ?? []).includes(run.test)),
      );
      if (namingLink) proven.add(i);
    });
  }
  return proven;
}

async function loadGraph(deps: FsDeps, root: string): Promise<GraphFile | null> {
  try {
    const raw = await deps.readFile(graphPath(root));
    const parsed = JSON.parse(raw) as GraphFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.functions)) return null;
    return {
      root: parsed.root ?? root,
      generated_at: parsed.generated_at ?? "",
      sources: parsed.sources ?? [],
      functions: parsed.functions ?? [],
      test_files: parsed.test_files ?? [],
      tests: parsed.tests ?? 0,
      test_links: parsed.test_links ?? [],
      runs: parsed.runs ?? [],
    };
  } catch {
    return null;
  }
}

async function persistGraph(deps: FsDeps, graph: GraphFile): Promise<void> {
  if (deps.mkdir) await deps.mkdir(joinPath(graph.root, ".gapproof"));
  await deps.writeFile(graphPath(graph.root), JSON.stringify(graph, null, 2));
}

function graphFromAnalysis(analysis: Analysis, generatedAt: string, runs: RunRecord[]): GraphFile {
  return {
    root: analysis.root,
    generated_at: generatedAt,
    sources: analysis.sources,
    functions: analysis.functions,
    test_files: analysis.testFiles,
    tests: analysis.tests,
    test_links: analysis.testLinks,
    runs,
  };
}

function linkedCount(analysis: Analysis): number {
  return analysis.linkedIndexes.size;
}

async function statsFor(deps: FsDeps, analysis: Analysis) {
  const stored = await loadGraph(deps, analysis.root);
  const runs = stored?.runs ?? [];
  const proven = provenIndexes(analysis.functions, analysis.testLinks, runs).size;
  const linked = linkedCount(analysis);
  return {
    files: analysis.sources.length + analysis.testFiles.length,
    functions: analysis.functions.length,
    tests: analysis.tests,
    test_files: analysis.testFiles.length,
    linked,
    unlinked: analysis.functions.length - linked,
    proven,
    runs: runs.length,
  };
}

function gapsFor(analysis: Analysis, limit?: number) {
  const gaps = analysis.functions
    .map((f, i) => ({ f, i }))
    .filter(({ i }) => !analysis.linkedIndexes.has(i))
    .sort((a, b) => {
      if (a.f.exported !== b.f.exported) return a.f.exported ? -1 : 1;
      return a.i - b.i;
    })
    .map(({ f }) => ({ function: f.name, file: f.file, exported: f.exported }));
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
      throw new Error("limit must be a non-negative number");
    }
    return gaps.slice(0, Math.floor(limit));
  }
  return gaps;
}

function scoreFor(functionsCount: number, linked: number, proven: number) {
  const linkedRatio = functionsCount ? linked / functionsCount : 0;
  const provenRatio = functionsCount ? proven / functionsCount : 0;
  return {
    score: Math.round((0.6 * linkedRatio + 0.4 * provenRatio) * 1000) / 10,
    linked_ratio: Math.round(linkedRatio * 10000) / 10000,
    proven_ratio: Math.round(provenRatio * 10000) / 10000,
    functions: functionsCount,
  };
}

// ---------------------------------------------------------------- tools

export async function orangeproStart(deps: FsDeps, args: RootArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  const existing = await loadGraph(deps, analysis.root);
  const graph = graphFromAnalysis(analysis, deps.now(), existing?.runs ?? []);
  await persistGraph(deps, graph);
  const linked = linkedCount(analysis);
  return {
    root: analysis.root,
    sources: analysis.sources.length,
    functions: analysis.functions.length,
    tests: analysis.tests,
    linked,
    unlinked: analysis.functions.length - linked,
  };
}

export async function orangeproAnalyzeSources(deps: FsDeps, args: RootArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  return {
    root: analysis.root,
    sources: analysis.sources,
    functions: analysis.functions.length,
  };
}

export async function orangeproFindTestGaps(deps: FsDeps, args: FindTestGapsArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  return gapsFor(analysis, args.limit);
}

export async function orangeproStatus(deps: FsDeps, args: RootArgs) {
  const root = requireRoot(args.root);
  const stored = await loadGraph(deps, root);
  if (stored) {
    const linkedSet = new Set<number>();
    stored.functions.forEach((f, i) => {
      if (stored.test_links.some((l) => l.functions.includes(f.name))) linkedSet.add(i);
    });
    const proven = provenIndexes(stored.functions, stored.test_links, stored.runs).size;
    return {
      exists: true,
      generated_at: stored.generated_at,
      counts: {
        sources: stored.sources.length,
        functions: stored.functions.length,
        tests: stored.tests,
        test_files: stored.test_files.length,
        linked: linkedSet.size,
        unlinked: stored.functions.length - linkedSet.size,
        proven,
        runs: stored.runs.length,
      },
    };
  }
  const analysis = await analyzeRepo(deps, root);
  const linked = linkedCount(analysis);
  return {
    exists: false,
    root: analysis.root,
    sources: analysis.sources.length,
    functions: analysis.functions.length,
    tests: analysis.tests,
    test_files: analysis.testFiles.length,
    linked,
    unlinked: analysis.functions.length - linked,
    proven: 0,
    runs: 0,
  };
}

export async function orangeproDoctor(deps: FsDeps, args: RootArgs) {
  const root = requireRoot(args.root);
  let topEntries;
  try {
    topEntries = await deps.readdir(root);
  } catch {
    return {
      root_exists: false,
      has_manifest: false,
      source_files: 0,
      test_files: 0,
      issues: ["root does not exist or is not a readable directory"],
    };
  }
  const hasManifest = topEntries.some(
    (e) => e.name === "package.json" || e.name === "pyproject.toml",
  );
  const analysis = await analyzeRepo(deps, root);
  const issues: string[] = [];
  if (!hasManifest) issues.push("no package.json or pyproject.toml found at the root");
  if (analysis.sources.length === 0) issues.push("no source files found");
  if (analysis.testFiles.length === 0) issues.push("no test files found");
  return {
    root_exists: true,
    has_manifest: hasManifest,
    source_files: analysis.sources.length,
    test_files: analysis.testFiles.length,
    issues,
  };
}

export async function orangeproGraphScore(deps: FsDeps, args: RootArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  const stats = await statsFor(deps, analysis);
  return scoreFor(stats.functions, stats.linked, stats.proven);
}

export async function orangeproStats(deps: FsDeps, args: RootArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  return statsFor(deps, analysis);
}

export async function orangeproRtm(deps: FsDeps, args: RootArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  const byId = new Map<string, { id: string; functions: string[]; covered: boolean }>();
  for (const source of analysis.sources) {
    const content = analysis.sourceContents.get(source.file) ?? "";
    const comments: string[] = [];
    if (source.file.endsWith(".py")) {
      for (const line of content.split(/\r?\n/)) {
        const idx = line.indexOf("#");
        if (idx >= 0) comments.push(line.slice(idx));
      }
    } else {
      for (const m of content.matchAll(/\/\*[\s\S]*?\*\//g)) comments.push(m[0]);
      for (const line of content.split(/\r?\n/)) {
        const idx = line.indexOf("//");
        if (idx >= 0) comments.push(line.slice(idx));
      }
    }
    const ids: string[] = [];
    for (const comment of comments) {
      for (const m of comment.matchAll(/\b[A-Z]+-\d+\b/g)) {
        if (!ids.includes(m[0])) ids.push(m[0]);
      }
    }
    for (const id of ids) {
      const entry = byId.get(id) ?? { id, functions: [], covered: false };
      for (const name of source.functions) {
        if (!entry.functions.includes(name)) entry.functions.push(name);
      }
      byId.set(id, entry);
    }
  }
  for (const entry of byId.values()) {
    entry.covered =
      entry.functions.length > 0 &&
      entry.functions.every((name) =>
        analysis.functions.some(
          (f, i) => f.name === name && analysis.linkedIndexes.has(i),
        ),
      );
  }
  return [...byId.values()];
}

export async function orangeproChangedImpact(deps: FsDeps, args: ChangedImpactArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  if (!Array.isArray(args.files) || args.files.some((f) => typeof f !== "string")) {
    throw new Error("files must be an array of strings");
  }
  const changed = new Set(
    args.files.map((f) => {
      let rel = f.trim();
      if (rel.startsWith(`${analysis.root}/`)) rel = rel.slice(analysis.root.length + 1);
      if (rel.startsWith("./")) rel = rel.slice(2);
      return rel;
    }),
  );
  const changedFunctions: string[] = [];
  analysis.functions.forEach((f) => {
    if (changed.has(f.file) && !changedFunctions.includes(f.name)) changedFunctions.push(f.name);
  });
  const affectedTests = analysis.testFiles.filter(
    (rel) =>
      changed.has(rel) ||
      changedFunctions.some((name) => mentions(analysis.testContents.get(rel) ?? "", name)),
  );
  const unlinkedChanged = changedFunctions.filter(
    (name) =>
      !analysis.functions.some((f, i) => f.name === name && analysis.linkedIndexes.has(i)),
  );
  return {
    changed_functions: changedFunctions,
    affected_tests: affectedTests,
    unlinked_changed: unlinkedChanged,
  };
}

export async function orangeproRecordRun(deps: FsDeps, args: RecordRunArgs) {
  const root = requireRoot(args.root);
  if (typeof args.test !== "string" || !args.test.trim()) {
    throw new Error("test must be a non-empty string");
  }
  if (args.outcome !== "pass" && args.outcome !== "fail") {
    throw new Error(`outcome must be "pass" or "fail"`);
  }
  if (
    args.functions !== undefined &&
    (!Array.isArray(args.functions) || args.functions.some((f) => typeof f !== "string"))
  ) {
    throw new Error("functions must be an array of strings");
  }
  const run: RunRecord = {
    test: args.test,
    outcome: args.outcome,
    ...(args.functions !== undefined ? { functions: args.functions } : {}),
    recorded_at: deps.now(),
  };
  let graph = await loadGraph(deps, root);
  if (!graph) {
    const analysis = await analyzeRepo(deps, root);
    graph = graphFromAnalysis(analysis, deps.now(), []);
  }
  graph.runs = [...graph.runs, run];
  await persistGraph(deps, graph);
  return { recorded: true, runs_total: graph.runs.length };
}

export async function orangeproExplainTest(deps: FsDeps, args: ExplainTestArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  if (typeof args.test !== "string" || !args.test.trim()) {
    throw new Error("test must be a non-empty string");
  }
  const file = analysis.testFiles.find((rel) => rel.includes(args.test));
  if (!file) throw new Error(`test not found: ${args.test}`);
  const link = analysis.testLinks.find((l) => l.file === file);
  const linkedFunctions = link?.functions ?? [];
  const stored = await loadGraph(deps, analysis.root);
  const proven = provenIndexes(analysis.functions, analysis.testLinks, stored?.runs ?? []);
  const provenFunctions = linkedFunctions.filter((name) =>
    analysis.functions.some((f, i) => f.name === name && proven.has(i)),
  );
  return {
    test: args.test,
    file,
    linked_functions: linkedFunctions,
    proven_functions: provenFunctions,
    content_excerpt: (analysis.testContents.get(file) ?? "").slice(0, 400),
  };
}

export async function orangeproExportEvidencePack(deps: FsDeps, args: RootArgs) {
  const analysis = await analyzeRepo(deps, args.root);
  const stats = await statsFor(deps, analysis);
  const score = scoreFor(stats.functions, stats.linked, stats.proven);
  const stored = await loadGraph(deps, analysis.root);
  return {
    generated_at: deps.now(),
    root: analysis.root,
    score: score.score,
    stats,
    gaps: gapsFor(analysis),
    runs: stored?.runs ?? [],
  };
}

/** Generic entry point used by the MCP server and the CLI. */
export async function callGapproofTool(
  deps: FsDeps,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const a = (args ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "orangepro_start":
      return orangeproStart(deps, a as unknown as RootArgs);
    case "orangepro_analyze_sources":
      return orangeproAnalyzeSources(deps, a as unknown as RootArgs);
    case "orangepro_find_test_gaps":
      return orangeproFindTestGaps(deps, a as unknown as FindTestGapsArgs);
    case "orangepro_status":
      return orangeproStatus(deps, a as unknown as RootArgs);
    case "orangepro_doctor":
      return orangeproDoctor(deps, a as unknown as RootArgs);
    case "orangepro_graph_score":
      return orangeproGraphScore(deps, a as unknown as RootArgs);
    case "orangepro_stats":
      return orangeproStats(deps, a as unknown as RootArgs);
    case "orangepro_rtm":
      return orangeproRtm(deps, a as unknown as RootArgs);
    case "orangepro_changed_impact":
      return orangeproChangedImpact(deps, a as unknown as ChangedImpactArgs);
    case "orangepro_record_run":
      return orangeproRecordRun(deps, a as unknown as RecordRunArgs);
    case "orangepro_explain_test":
      return orangeproExplainTest(deps, a as unknown as ExplainTestArgs);
    case "orangepro_export_evidence_pack":
      return orangeproExportEvidencePack(deps, a as unknown as RootArgs);
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}
