# Contributing

## Development

```bash
bun install
bun run check
```

## Project Layout

- `server.ts`: MCP stdio server and tool handlers.
- `cli.ts`: local management CLI for setup, status, and mode switching.
- `shared/`: review prompt, git diff, type, and SQLite store helpers.
- `test/`: Bun tests for routing, prompt construction, and tool exposure.

## Pull Requests

Keep changes focused and include tests for behavior changes. For MCP tool changes, update `README.md` and ensure the tool description clearly states when assistants should call it.
