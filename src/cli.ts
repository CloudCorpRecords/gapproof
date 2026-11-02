#!/usr/bin/env node
/**
 * gapproof CLI.
 *
 *   gapproof <tool-name> '<json-arguments>'
 *   gapproof mcp
 *   gapproof --version
 *
 * <tool-name> is any of the 12 MCP tool names, e.g.
 *   gapproof orangepro_start '{"root":"/path/to/repo"}'
 *   gapproof orangepro_find_test_gaps '{"root":"/path/to/repo","limit":5}'
 *   gapproof orangepro_record_run '{"root":"/path/to/repo","test":"math","outcome":"pass"}'
 *
 * All tools are local: no network, no API key. Exit codes:
 * 0 success, 1 analysis/validation error, 2 usage error.
 */
import { callGapproofTool, defaultDeps, TOOL_NAMES, VERSION } from "./gapproof.js";

function usage(): never {
  console.error(`Usage:
  gapproof <tool-name> '<json-arguments>'
  gapproof mcp
  gapproof --version
Tools: ${TOOL_NAMES.join(", ")}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (!cmd || !(TOOL_NAMES as readonly string[]).includes(cmd)) usage();
  let args: Record<string, unknown> = {};
  const raw = rest.join(" ").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) usage();
      args = parsed as Record<string, unknown>;
    } catch {
      usage();
    }
  }
  try {
    const result = await callGapproofTool(defaultDeps(), cmd, args);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
