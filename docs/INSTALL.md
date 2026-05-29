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

Add this to your Codex `config.toml`. Replace the path with the real
`dist/index.js` path from your local clone.

```toml
[mcp_servers.x_search]
command = "node"
args = ["/path/to/your/x-search-mcp/dist/index.js"]

[mcp_servers.x_search.env]
XAI_API_KEY = "xai-your-key-here"
```

On Windows, escape backslashes in TOML strings:

```toml
[mcp_servers.x_search]
command = "node"
args = ["C:\\Users\\tt\\Documents\\code\\x-search-mcp\\dist\\index.js"]

[mcp_servers.x_search.env]
XAI_API_KEY = "xai-your-key-here"
```

Do not paste the placeholder path as-is. If Codex shows `MCP startup failed:
handshaking with MCP server failed`, first check that the configured file exists.

Restart Codex after changing MCP config.

## Notes

Keep the API key out of git. Either set it in the MCP config's `env` block or
make sure the Codex parent process inherits `XAI_API_KEY`.
