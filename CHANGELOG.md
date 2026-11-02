# Changelog

## 0.1.0 (2026-10-26)

- Initial release. Labelled core subset (12 tools) of the Orangepro MCP tool list.
- CLI: one subcommand per MCP tool (same name as the tool), each taking
  its arguments as a JSON object on the command line, plus `--version`.
- MCP server (`gapproof mcp`, stdio) with 12 tools: `orangepro_start`,
  `orangepro_analyze_sources`, `orangepro_find_test_gaps`,
  `orangepro_status`, `orangepro_doctor`, `orangepro_graph_score`,
  `orangepro_stats`, `orangepro_rtm`, `orangepro_changed_impact`,
  `orangepro_record_run`, `orangepro_explain_test`, and
  `orangepro_export_evidence_pack`.
- Local static analysis only (no network, no API key): regex function
  extraction for TypeScript/JavaScript and Python, name-based test
  linking, a persisted gap graph at `<root>/.gapproof/graph.json`,
  recorded runs for proven coverage, a 60/40 linked/proven score,
  comment-based requirement-id extraction, and changed-file impact.
