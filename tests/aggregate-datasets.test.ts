import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("state/deploys.json", () => {
  const stateDir = path.resolve("state");

  it("exists and is valid JSON", () => {
    const p = path.join(stateDir, "deploys.json");
    expect(fs.existsSync(p)).toBe(true);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(data).toHaveProperty("generated_at");
    expect(data).toHaveProperty("events");
    expect(Array.isArray(data.events)).toBe(true);
  });

  it("events have required fields", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(stateDir, "deploys.json"), "utf8")
    );
    for (const event of data.events) {
      expect(event).toHaveProperty("timestamp");
      expect(event).toHaveProperty("app_name");
      expect(event).toHaveProperty("deploy_url");
      expect(event).toHaveProperty("status");
    }
  });
});

describe("state/graph.json", () => {
  const stateDir = path.resolve("state");

  it("exists and has nodes + edges", () => {
    const p = path.join(stateDir, "graph.json");
    expect(fs.existsSync(p)).toBe(true);
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(data).toHaveProperty("generated_at");
    expect(data).toHaveProperty("nodes");
    expect(data).toHaveProperty("edges");
    expect(Array.isArray(data.nodes)).toBe(true);
    expect(Array.isArray(data.edges)).toBe(true);
  });

  it("nodes have required fields", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(stateDir, "graph.json"), "utf8")
    );
    for (const node of data.nodes) {
      expect(node).toHaveProperty("service");
      expect(node).toHaveProperty("version");
      expect(node).toHaveProperty("url");
      expect(node).toHaveProperty("last_deployed");
    }
  });

  it("edges reference existing nodes", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(stateDir, "graph.json"), "utf8")
    );
    const nodeNames = new Set(data.nodes.map((n: any) => n.service));
    for (const edge of data.edges) {
      expect(nodeNames.has(edge.from), `Unknown node: ${edge.from}`).toBe(true);
      expect(nodeNames.has(edge.to), `Unknown node: ${edge.to}`).toBe(true);
    }
  });

  it("no duplicate nodes", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(stateDir, "graph.json"), "utf8")
    );
    const names = data.nodes.map((n: any) => n.service);
    expect(new Set(names).size).toBe(names.length);
  });

  it("no duplicate edges", () => {
    const data = JSON.parse(
      fs.readFileSync(path.join(stateDir, "graph.json"), "utf8")
    );
    const edgeKeys = data.edges.map((e: any) => `${e.from}->${e.to}`);
    expect(new Set(edgeKeys).size).toBe(edgeKeys.length);
  });
});

describe("deploys/ raw files", () => {
  it("all JSON files are valid", () => {
    const deploysDir = path.resolve("deploys");
    if (!fs.existsSync(deploysDir)) return;

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p));
        else if (entry.name.endsWith(".json")) out.push(p);
      }
      return out;
    }

    const files = walk(deploysDir);
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      expect(() => JSON.parse(raw), `Invalid JSON: ${file}`).not.toThrow();
    }
  });
});
