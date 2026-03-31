const stage = document.getElementById("stage");
const viewport = document.getElementById("viewport");
const svg = document.getElementById("links");
const nodesLayer = document.getElementById("nodes");
const meta = document.getElementById("meta");

const state = {
  transform: d3.zoomIdentity,
  layout: null,
  zoom: null,
};

function setTransform(t) {
  state.transform = t;
  viewport.style.transform = `translate(${t.x}px, ${t.y}px) scale(${t.k})`;
}

function resizeSvg(w, h) {
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
}

function clear() {
  nodesLayer.innerHTML = "";
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function formatUpdated(ts) {
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = String(d.getFullYear());
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `Last updated ${dd}.${mm}.${yyyy} ${hh}:${min}:${ss}`;
  } catch {
    return "";
  }
}

function buildTreeFromDag(nodes, edges) {
  const nodeMap = new Map(nodes.map((n) => [n.service, n]));
  const children = new Map();
  const hasParent = new Set();

  for (const { from, to } of edges) {
    if (!children.has(from)) children.set(from, []);
    children.get(from).push(to);
    hasParent.add(to);
  }

  // Root nodes = no incoming edges
  const roots = nodes.filter((n) => !hasParent.has(n.service));

  function buildNode(name, visited) {
    const data = nodeMap.get(name) || { service: name };
    const node = { ...data };
    if (visited.has(name)) return node;
    visited.add(name);
    const deps = children.get(name);
    if (deps && deps.length) {
      node.children = deps.map((d) => buildNode(d, visited));
    }
    visited.delete(name);
    return node;
  }

  if (roots.length === 1) {
    return buildNode(roots[0].service, new Set());
  }

  return {
    service: "root",
    children: roots.map((r) => buildNode(r.service, new Set())),
  };
}

function envFromVersion(version) {
  if (!version) return "";
  if (version.startsWith("pr-") || version.startsWith("pr")) return "pr";
  if (version.startsWith("rel-") || version.startsWith("rel")) return "rel";
  return "";
}

function render(treeData) {
  clear();

  const root = d3.hierarchy(treeData);
  const dx = 110;
  const dy = 340;
  const layout = d3.tree().nodeSize([dx, dy]);
  layout(root);

  const nodes = root.descendants();
  const links = root.links();

  const isHiddenRoot = (n) =>
    n.depth === 0 && n.data?.service === "root";

  const visibleNodes = nodes.filter((n) => !isHiddenRoot(n));

  const x0 = d3.min(visibleNodes, (d) => d.x) ?? 0;
  const x1 = d3.max(visibleNodes, (d) => d.x) ?? 0;
  const y0 = d3.min(visibleNodes, (d) => d.y) ?? 0;
  const y1 = d3.max(visibleNodes, (d) => d.y) ?? 0;

  const margin = 80;
  const width = y1 - y0 + margin * 2;
  const height = x1 - x0 + margin * 2;

  resizeSvg(width, height);

  viewport.style.width = `${width}px`;
  viewport.style.height = `${height}px`;
  nodesLayer.style.width = `${width}px`;
  nodesLayer.style.height = `${height}px`;

  const shiftX = margin - y0;
  const shiftY = margin - x0;

  const nodeBoxes = new Map();

  for (const n of nodes) {
    if (isHiddenRoot(n)) continue;

    const div = document.createElement("div");
    div.className = "node";

    const label = n.data.service || "unknown";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = label;

    if (n.data.version) {
      const v = document.createElement("span");
      v.className = "version";
      v.textContent = ` ${n.data.version}`;
      name.appendChild(v);
    }

    div.appendChild(name);

    if (n.data.url) {
      const line = document.createElement("a");
      line.className = "line";
      line.textContent = n.data.url;
      line.href = n.data.url;
      line.target = "_blank";
      line.rel = "noreferrer";
      div.appendChild(line);
    }

    const left = n.y + shiftX;
    const top = n.x + shiftY;

    div.style.left = `${left}px`;
    div.style.top = `${top}px`;

    nodesLayer.appendChild(div);

    nodeBoxes.set(n, { div, cx: left, cy: top, w: 0, h: 0 });
  }

  for (const box of nodeBoxes.values()) {
    box.w = box.div.offsetWidth || 0;
    box.h = box.div.offsetHeight || 0;
  }

  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(g);

  for (const l of links) {
    if (isHiddenRoot(l.source)) continue;

    const s = nodeBoxes.get(l.source);
    const t = nodeBoxes.get(l.target);
    if (!s || !t) continue;

    const x1 = s.cx + s.w;
    const y1 = s.cy;
    const x2 = t.cx;
    const y2 = t.cy;

    const dx = x2 - x1;
    const c1x = x1 + dx * 0.5;
    const c2x = x2 - dx * 0.5;

    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("class", "link");
    p.setAttribute(
      "d",
      `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`
    );
    g.appendChild(p);
  }

  const stageRect = stage.getBoundingClientRect();
  const stageW = stageRect.width || 0;
  const stageH = stageRect.height || 0;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of nodeBoxes.values()) {
    minX = Math.min(minX, b.cx);
    maxX = Math.max(maxX, b.cx + b.w);
    minY = Math.min(minY, b.cy - b.h / 2);
    maxY = Math.max(maxY, b.cy + b.h / 2);
  }

  const bboxW = Number.isFinite(minX) ? maxX - minX : width;
  const bboxH = Number.isFinite(minY) ? maxY - minY : height;
  const pad = 20;
  const tx = Math.max(pad, (stageW - bboxW) / 2 - (Number.isFinite(minX) ? minX : 0));
  const ty = Math.max(pad, (stageH - bboxH) / 2 - (Number.isFinite(minY) ? minY : 0));

  const initial = d3.zoomIdentity.translate(tx, ty).scale(1);
  if (state.zoom) {
    d3.select(stage).call(state.zoom.transform, initial);
  } else {
    setTransform(initial);
  }

  state.layout = { width, height };
}

async function main() {
  const res = await fetch("./state/graph.json", { cache: "no-store" });
  const data = await res.json();

  if (data.generated_at) {
    meta.textContent = formatUpdated(data.generated_at);
  }

  const zoom = d3
    .zoom()
    .scaleExtent([0.25, 2.5])
    .on("zoom", (event) => setTransform(event.transform));

  state.zoom = zoom;
  d3.select(stage).call(zoom);

  // New DAG format: nodes + edges
  if (data.nodes && data.edges) {
    const treeData = buildTreeFromDag(data.nodes, data.edges);
    render(treeData);
  }
  // Legacy tree format
  else if (data.root) {
    render(data.root);
  }
}

main().catch((e) => {
  meta.textContent = String(e);
});
