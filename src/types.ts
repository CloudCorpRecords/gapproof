/**
 * gapproof types.
 *
 * Every tool takes a repository root (plus a small number of extra
 * arguments) and returns plain JSON-shaped data describing the
 * repository's test-gap graph. All filesystem access goes through
 * the injectable FsDeps surface, and every timestamp comes from an
 * injectable clock, so tests run against an in-memory fixture repo
 * with deterministic times and never touch a real disk or network.
 */

/** One extracted function definition in a source file. */
export interface FunctionInfo {
  name: string;
  /** Repository-relative path of the defining file (posix separators). */
  file: string;
  exported: boolean;
}

/** Per-source-file function list, as returned by analyze_sources. */
export interface SourceFileInfo {
  file: string;
  functions: string[];
}

/** One recorded test run, persisted in the gap graph. */
export interface RunRecord {
  test: string;
  outcome: "pass" | "fail";
  functions?: string[];
  recorded_at: string;
}

/** Which functions each test file mentions (its links). */
export interface TestLink {
  file: string;
  functions: string[];
  /** Test-case names declared in the file (it/test names, def test_*). */
  tests?: string[];
}

/** The persisted graph, stored at <root>/.gapproof/graph.json. */
export interface GraphFile {
  root: string;
  generated_at: string;
  sources: SourceFileInfo[];
  functions: FunctionInfo[];
  test_files: string[];
  /** Number of individual test cases found in the test files. */
  tests: number;
  test_links: TestLink[];
  runs: RunRecord[];
}

export interface RootArgs {
  root: string;
}

export interface FindTestGapsArgs {
  root: string;
  limit?: number;
}

export interface ChangedImpactArgs {
  root: string;
  files: string[];
}

export interface RecordRunArgs {
  root: string;
  test: string;
  outcome: "pass" | "fail";
  functions?: string[];
}

export interface ExplainTestArgs {
  root: string;
  test: string;
}

/** A directory entry, shaped like the subset of fs Dirent we use. */
export interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/**
 * Injectable filesystem + clock surface. The default implementation
 * uses node:fs/promises; tests substitute an in-memory fixture repo.
 * `mkdir` is optional: the default implementation creates the
 * .gapproof directory before writing, in-memory ones may record it.
 */
export interface FsDeps {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<DirEntryLike[]>;
  writeFile(path: string, data: string): Promise<void>;
  mkdir?(path: string): Promise<void>;
  now(): string;
}
