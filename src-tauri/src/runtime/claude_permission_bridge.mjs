const firstUserArg = process.argv[1];
const bridgeUrl = firstUserArg?.startsWith("http://") || firstUserArg?.startsWith("https://")
  ? firstUserArg
  : process.argv[2];
const token = bridgeUrl === firstUserArg ? process.argv[2] : process.argv[3];

let buffer = "";
let framing = "unknown";

function send(message) {
  const text = JSON.stringify(message);
  if (framing === "headers") {
    const bytes = Buffer.byteLength(text, "utf8");
    process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${text}`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function err(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function parseHeaderMessage() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;

  const header = buffer.slice(0, headerEnd);
  const match = /content-length:\s*(\d+)/i.exec(header);
  if (!match) {
    buffer = "";
    return null;
  }

  const length = Number(match[1]);
  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + length) return null;

  const body = buffer.slice(bodyStart, bodyStart + length);
  buffer = buffer.slice(bodyStart + length);
  return body;
}

function processBuffer() {
  if (framing === "unknown" && buffer.startsWith("Content-Length:")) {
    framing = "headers";
  }

  if (framing === "headers") {
    for (;;) {
      const body = parseHeaderMessage();
      if (body == null) break;
      handleBody(body);
    }
    return;
  }

  framing = "lines";
  for (;;) {
    const idx = buffer.indexOf("\n");
    if (idx < 0) break;
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handleBody(line);
  }
}

function handleBody(body) {
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (error) {
    console.error(`[workbench-permission-bridge] invalid json: ${error.message}`);
    return;
  }
  handleMessage(msg).catch((error) => {
    if (msg && Object.prototype.hasOwnProperty.call(msg, "id")) {
      err(msg.id, -32603, error.message || String(error));
    }
  });
}

async function handleMessage(msg) {
  const id = msg.id;
  const method = msg.method;

  if (!method) return;
  if (id == null && method.startsWith("notifications/")) return;

  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: msg.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "workbench-permission-bridge", version: "0.1.0" },
      });
      break;
    case "ping":
      ok(id, {});
      break;
    case "tools/list":
      ok(id, {
        tools: [
          {
            name: "approval_prompt",
            description: "Ask Workbench whether Claude Code may run a protected tool call.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object", additionalProperties: true },
              },
              required: ["tool_name", "input"],
              additionalProperties: true,
            },
          },
        ],
      });
      break;
    case "tools/call":
      await handleToolCall(id, msg.params || {});
      break;
    default:
      err(id, -32601, `Method not found: ${method}`);
      break;
  }
}

async function handleToolCall(id, params) {
  if (params.name !== "approval_prompt") {
    err(id, -32602, `Unknown tool: ${params.name}`);
    return;
  }

  const args = params.arguments || {};
  const decision = await postPermissionRequest({
    tool_name: String(args.tool_name || args.toolName || "tool"),
    input: args.input && typeof args.input === "object" ? args.input : {},
  });

  ok(id, {
    content: [{ type: "text", text: JSON.stringify(decision) }],
  });
}

function postPermissionRequest(payload) {
  return new Promise((resolve) => {
    const url = new URL(bridgeUrl);
    const body = JSON.stringify(payload);
    import(url.protocol === "https:" ? "node:https" : "node:http")
      .then((lib) => {
        const req = lib.request(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body, "utf8"),
            },
          },
          (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              data += chunk;
            });
            res.on("end", () => {
              try {
                resolve(JSON.parse(data));
              } catch {
                resolve({ behavior: "deny", message: "Workbench permission bridge returned invalid JSON." });
              }
            });
          }
        );

        req.on("error", (error) => {
          resolve({ behavior: "deny", message: `Workbench permission bridge failed: ${error.message}` });
        });
        req.write(body);
        req.end();
      })
      .catch((error) => {
        resolve({ behavior: "deny", message: `Workbench permission bridge failed: ${error.message}` });
      });
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  processBuffer();
});
