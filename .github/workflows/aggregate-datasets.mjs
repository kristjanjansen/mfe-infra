import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const deploysRoot = path.join(repoRoot, "deploys");
const stateDir = path.join(repoRoot, "state");

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const eventFiles = walk(deploysRoot);
const events = [];
for (const f of eventFiles) {
  try {
    const e = readJson(f);
    if (e && typeof e === "object") events.push(e);
  } catch {
    // ignore
  }
}

events.sort((a, b) =>
  String(a.timestamp || "").localeCompare(String(b.timestamp || ""))
);

fs.mkdirSync(stateDir, { recursive: true });

const generatedAt = new Date().toISOString();

// Write deploys.json (flat event list)
fs.writeFileSync(
  path.join(stateDir, "deploys.json"),
  JSON.stringify({ generated_at: generatedAt, events }, null, 2) + "\n"
);

// Build DAG: unique nodes + edges
const nodes = new Map();
const edgeSet = new Set();

function upsertNode(name, data) {
  const ts = String(data.timestamp || "");
  const existing = nodes.get(name);

  if (!existing || ts >= String(existing.last_deployed || "")) {
    nodes.set(name, {
      service: name,
      version: data.environment
        ? `${data.environment}-${extractVersion(data.deploy_url, name)}`
        : "",
      url: data.deploy_url || "",
      status: data.status || existing?.status || "",
      last_deployed: data.timestamp || existing?.last_deployed || "",
    });
  }
}

function extractVersion(deployUrl, serviceName) {
  try {
    const host = new URL(deployUrl).hostname;
    const label = host.split(".")[0];
    const prefix = serviceName + "-";
    if (label.startsWith(prefix)) {
      return label.slice(prefix.length).replace(/^(pr-|rel-)/, "");
    }
  } catch {
    // ignore
  }
  return "";
}

for (const event of events) {
  if (!event.app_name) continue;
  upsertNode(event.app_name, event);

  if (Array.isArray(event.services)) {
    for (const svc of event.services) {
      if (!svc.app_name) continue;
      upsertNode(svc.app_name, svc);
      edgeSet.add(`${event.app_name}->${svc.app_name}`);
    }
  }
}

const edges = [...edgeSet].sort().map((e) => {
  const [from, to] = e.split("->");
  return { from, to };
});

const graphJson = {
  generated_at: generatedAt,
  nodes: [...nodes.values()],
  edges,
};

fs.writeFileSync(
  path.join(stateDir, "graph.json"),
  JSON.stringify(graphJson, null, 2) + "\n"
);
