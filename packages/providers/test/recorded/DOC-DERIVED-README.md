# Doc-derived fixtures (NOT captured from a live call)

The files named `DOC-DERIVED-*` in this folder were written by hand from the wire shapes in the
Anthropic documentation of the tool search tool, read on 19/11/2026:

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool ("Response format"
  and "Streaming": `server_tool_use`, `tool_search_tool_result` with
  `tool_search_tool_search_result` and `tool_references`, then a `tool_use` of the discovered tool)
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching

No request in this repository was ever sent to the real API with these shapes. When a real call is
made, record it (like the other files here) and replace these.
