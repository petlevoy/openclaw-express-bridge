#!/usr/bin/env node
import { writeFile } from "node:fs/promises";

const cdp = process.env.EXPRESS_CDP_URL || "http://127.0.0.1:18997";
const output = process.argv[2];
if (!output) throw new Error("output path is required");
const targets = await (await fetch(`${cdp}/json/list`)).json();
const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
if (!target) throw new Error("no eXpress page target found");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 1;
function request(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", handler);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result || {});
    };
    socket.addEventListener("message", handler);
  });
}
await request("Page.enable");
const result = await request("Page.captureScreenshot", { format: "png", fromSurface: true });
await writeFile(output, Buffer.from(result.data, "base64"), { mode: 0o600 });
socket.close();
console.log(output);
