# Install

This package exposes a single MCP tool, `x_search`, backed by xAI's Responses API
and server-side `x_search` tool.

## Prerequisites

- Node.js 18 or newer
- An xAI API key in `XAI_API_KEY`

## Local install

```bash
git clone https://github.com/thomastraum/x-search-mcp.git
cd x-search-mcp
npm install
npm run build
```

## Codex MCP config

Add this to your Codex `config.toml`, adjusting the path to match where you
cloned the repository:

```toml
[mcp_servers.x_search]
command = "node"
args = ["/absolute/path/to/x-search-mcp/dist/index.js"]

[mcp_servers.x_search.env]
XAI_API_KEY = "xai-your-key-here"
```

Restart Codex after changing MCP config.

## Notes

Keep the API key out of git. Either set it in the MCP config's `env` block or
make sure the Codex parent process inherits `XAI_API_KEY`.
