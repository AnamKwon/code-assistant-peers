const MCP_SERVER_NAME = "code-assistant-peers";

export function upsertCodexMcpTimeoutConfig(current: string, serverPath: string, timeoutSec: number): string {
  const header = `[mcp_servers.${MCP_SERVER_NAME}]`;
  const escapedServerPath = serverPath.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  const fallbackBlock = [
    header,
    'command = "bun"',
    `args = ["${escapedServerPath}"]`,
    "startup_timeout_sec = 30",
    `tool_timeout_sec = ${timeoutSec}`,
    "",
  ].join("\n");
  if (!current.trim()) return `${fallbackBlock}\n`;

  const lines = current.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    return `${current.replace(/\s*$/, "\n\n")}${fallbackBlock}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const section = lines.slice(start, end);
  const withCommand = upsertTomlKey(section, "command", '"bun"');
  const withArgs = upsertTomlKey(withCommand, "args", `["${escapedServerPath}"]`);
  const withStartupTimeout = upsertTomlKey(withArgs, "startup_timeout_sec", "30");
  const withToolTimeout = upsertTomlKey(withStartupTimeout, "tool_timeout_sec", String(timeoutSec));
  const updated = [...lines.slice(0, start), ...withToolTimeout, ...lines.slice(end)].join("\n");
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

function upsertTomlKey(lines: string[], key: string, value: string): string[] {
  const index = lines.findIndex((line) => line.trim().startsWith(`${key} `) || line.trim().startsWith(`${key}=`));
  if (index === -1) return [...lines, `${key} = ${value}`];
  const updated = [...lines];
  updated[index] = `${key} = ${value}`;
  return updated;
}
