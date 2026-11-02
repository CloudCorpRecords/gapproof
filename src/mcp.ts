/**
 * gapproof MCP server. Tools: orangepro_start, orangepro_analyze_sources,
 * orangepro_find_test_gaps, orangepro_status, orangepro_doctor,
 * orangepro_graph_score, orangepro_stats, orangepro_rtm,
 * orangepro_changed_impact, orangepro_record_run, orangepro_explain_test,
 * orangepro_export_evidence_pack.
 *
 * Why the low-level Server instead of McpServer: the high-level helper
 * converts zod schemas to JSON Schema and injects keys that are not in
 * this tool's public spec ("$schema" and "additionalProperties"), which
 * breaks exact tool-list/schema parity with the spec. This file serves
 * tools/list with the spec's exact input schemas as explicit literals,
 * while zod still validates every tools/call argument set.
 *
 * This is a labelled core subset (12 of 18 documented tools). All tools
 * are local: they read (and, for start/record_run, write) files under
 * the given repository root only. No network, no API key.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callGapproofTool, defaultDeps, VERSION } from "./gapproof.js";

const RootOnly = z.object({ root: z.string() });
const FindTestGaps = z.object({ root: z.string(), limit: z.number().optional() });
const ChangedImpact = z.object({ root: z.string(), files: z.array(z.string()) });
const RecordRun = z.object({
  root: z.string(),
  test: z.string(),
  outcome: z.enum(["pass", "fail"]),
  functions: z.array(z.string()).optional(),
});
const ExplainTest = z.object({ root: z.string(), test: z.string() });

const STRING_ARRAY = {
  type: "array" as const,
  items: { type: "string" as const },
  description: "Array of strings.",
};

const TOOLS = [
  {
    name: "orangepro_start",
    description: "Analyze a repository, persist its gap graph, and return summary counts.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
  {
    name: "orangepro_analyze_sources",
    description: "Analyze source files and list the functions found in each, without persisting.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
  {
    name: "orangepro_find_test_gaps",
    description: "List functions with no linked test, exported first, then in file order.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: { type: "number", description: "Maximum number of test gaps to return." },
        root: { type: "string", description: "Path to the repository root directory." },
      },
      required: ["root"],
    },
  },
  {
    name: "orangepro_status",
    description: "Report whether a persisted gap graph exists, with counts, or a fresh snapshot.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
  {
    name: "orangepro_doctor",
    description: "Check a repository layout: root, manifest, sources, tests, and issues.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
  {
    name: "orangepro_graph_score",
    description: "Score test coverage: 60% linked ratio plus 40% proven ratio, 0 to 100.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
  {
    name: "orangepro_stats",
    description: "Return counts of files, functions, tests, links, proven functions, and runs.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
  {
    name: "orangepro_rtm",
    description: "Extract requirement ids from source comments and report their covering functions.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
  {
    name: "orangepro_changed_impact",
    description: "Report functions changed in the given files, affected tests, and unlinked changes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        files: STRING_ARRAY,
        root: { type: "string", description: "Path to the repository root directory." },
      },
      required: ["root", "files"],
    },
  },
  {
    name: "orangepro_record_run",
    description: "Record a test run outcome against the gap graph.",
    inputSchema: {
      type: "object" as const,
      properties: {
        functions: STRING_ARRAY,
        outcome: { type: "string", description: "Test run outcome: pass or fail." },
        root: { type: "string", description: "Path to the repository root directory." },
        test: { type: "string", description: "Test file or test case name for the run." },
      },
      required: ["root", "test", "outcome"],
    },
  },
  {
    name: "orangepro_explain_test",
    description: "Explain one test file: its linked and proven functions and a content excerpt.",
    inputSchema: {
      type: "object" as const,
      properties: {
        root: { type: "string", description: "Path to the repository root directory." },
        test: { type: "string", description: "Name or path of the test file to explain." },
      },
      required: ["root", "test"],
    },
  },
  {
    name: "orangepro_export_evidence_pack",
    description: "Return an evidence pack with score, stats, gaps, and recorded runs; writes nothing.",
    inputSchema: {
      type: "object" as const,
      properties: { root: { type: "string", description: "Path to the repository root directory." } },
      required: ["root"],
    },
  },
];

const SCHEMAS: Record<string, z.ZodTypeAny> = {
  orangepro_start: RootOnly,
  orangepro_analyze_sources: RootOnly,
  orangepro_find_test_gaps: FindTestGaps,
  orangepro_status: RootOnly,
  orangepro_doctor: RootOnly,
  orangepro_graph_score: RootOnly,
  orangepro_stats: RootOnly,
  orangepro_rtm: RootOnly,
  orangepro_changed_impact: ChangedImpact,
  orangepro_record_run: RecordRun,
  orangepro_explain_test: ExplainTest,
  orangepro_export_evidence_pack: RootOnly,
};

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const server = new Server(
  { name: "gapproof", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const schema = SCHEMAS[name];
  if (!schema) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  try {
    const parsed = schema.parse(args ?? {}) as Record<string, unknown>;
    return textResult(await callGapproofTool(defaultDeps(), name, parsed));
  } catch (err) {
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
