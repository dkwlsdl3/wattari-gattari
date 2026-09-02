import path from "node:path";

import { Broker } from "./broker.mjs";
import { request } from "./client.mjs";
import { FakeAdapter } from "./adapters/fake.mjs";

const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
const socketPath = path.join(runtimeDir, `waga-demo-${process.pid}.sock`);
const fake = new FakeAdapter({ agents: [{ name: "codex2" }, { name: "claude3", serialRequests: true }] });
const broker = new Broker({ socketPath, adapters: [fake] });

try {
  await broker.start();
  const agents = await request("list_agents", {}, { socketPath });
  const answer = await request("ask_agent", { target: "claude3", task: "ping", timeoutMs: 1_000 }, { socketPath });
  console.log(JSON.stringify({ agents, answer }, null, 2));
} finally {
  await broker.close();
}
