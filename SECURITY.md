# Security Policy

## Supported Versions

Security fixes target the latest published version.

## Reporting a Vulnerability

Please report vulnerabilities privately through the GitHub repository security advisory flow when available. If advisories are not enabled, open a minimal issue that states a private report is needed without publishing exploit details.

## Security Notes

This MCP server launches local CLI tools (`codex` and `claude`) and stores review history in a local SQLite database. Reviewers are invoked in read-only or plan-oriented modes where possible, but users should still review their local assistant, sandbox, and project trust settings before using the server on sensitive repositories.
