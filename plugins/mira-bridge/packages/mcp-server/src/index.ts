import { serveStdio } from "./server.js";

if (!process.argv.includes("--stdio")) {
  process.stderr.write("Usage: mirabridge-mcp --stdio\n");
  process.exitCode = 64;
} else {
  await serveStdio();
}

export { ToolDispatcher } from "./dispatcher.js";
export { createServer, serveStdio } from "./server.js";
export { SshPool, SshRpcClient } from "./ssh-rpc.js";
