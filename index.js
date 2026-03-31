const stage = document.getElementById("stage");
const viewport = document.getElementById("viewport");
const svg = document.getElementById("links");
const nodesLayer = document.getElementById("nodes");
const meta = document.getElementById("meta");

const state = { transform: d3.zoomIdentity, zoom: null };

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
    const pad = (n) => String(n).padStart(2, "0");
    return `Last updated ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return "";
  }
}

function renderDag(data) {
  clear();

  const { nodes, edges } = data;
  if (!nodes.length) return;

  // Build adjacency
  const childMap = new Map();
  const parentMap = new Map();
  for (const e of edges) {
    if (!childMap.has(e.from)) childMap.set(e.from, []);
    childMap.get(e.from).push(e.to);
    if (!parentMap.has(e.to)) parentMap.set(e.to, []);
    parentMap.get(e.to).push(e.from);
  }

  // Assign columns (depth = longest path from any root)
  const depth = new Map();
  const roots = nodes.filter((n) => !parentMap.has(n.service) || parentMap.get(n.service).length === 0);

  function assignDepth(name, d) {
    if (depth.has(name) && depth.get(name) >= d) return;
    depth.set(name, d);
    const children = childMap.get(name) || [];
    for (const c of children) assignDepth(c, d + 1);
  }
  for (const r of roots) assignDepth(r.service, 0);
  // Nodes with no depth (disconnected) get column 0
  for (const n of nodes) if (!depth.has(n.service)) depth.set(n.service, 0);

  // Group by column
  const columns = new Map();
  for (const n of nodes) {
    const col = depth.get(n.service);
    if (!columns.has(col)) columns.set(col, []);
    columns.get(col).push(n);
  }

  // Layout
  const colWidth = 380;
  const rowHeight = 120;
  const margin = 60;

  const maxCol = Math.max(...columns.keys());
  const maxRows = Math.max(...[...columns.values()].map((c) => c.length));

  const width = (maxCol + 1) * colWidth + margin * 2;
  const height = maxRows * rowHeight + margin * 2;

  resizeSvg(width, height);
  viewport.style.width = `${width}px`;
  viewport.style.height = `${height}px`;
  nodesLayer.style.width = `${width}px`;
  nodesLayer.style.height = `${height}px`;

  // Position nodes
  const positions = new Map();

  for (const [col, colNodes] of columns) {
    const x = margin + col * colWidth;
    const totalHeight = colNodes.length * rowHeight;
    const startY = margin + (height - margin * 2 - totalHeight) / 2;

    colNodes.forEach((n, i) => {
      const y = startY + i * rowHeight;
      positions.set(n.service, { x, y, w: 0, h: 0 });
    });
  }

  // Render nodes
  const nodeMap = new Map(nodes.map((n) => [n.service, n]));
  const divs = new Map();

  for (const n of nodes) {
    const pos = positions.get(n.service);
    const div = document.createElement("div");
    div.className = "node";
    div.style.left = `${pos.x}px`;
    div.style.top = `${pos.y}px`;

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = n.service;
    if (n.version) {
      const v = document.createElement("span");
      v.className = "version";
      v.textContent = ` ${n.version}`;
      name.appendChild(v);
    }
    div.appendChild(name);

    if (n.url) {
      const link = document.createElement("a");
      link.className = "line";
      link.textContent = n.url;
      link.href = n.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      div.appendChild(link);
    }

    nodesLayer.appendChild(div);
    divs.set(n.service, div);
  }

  // Measure nodes
  for (const [name, div] of divs) {
    const pos = positions.get(name);
    pos.w = div.offsetWidth || 0;
    pos.h = div.offsetHeight || 0;
  }

  // Draw edges
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  svg.appendChild(g);

  for (const e of edges) {
    const s = positions.get(e.from);
    const t = positions.get(e.to);
    if (!s || !t) continue;

    const x1 = s.x + s.w;
    const y1 = s.y + s.h / 2;
    const x2 = t.x;
    const y2 = t.y + t.h / 2;
    const dx = x2 - x1;

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", "link");
    path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx * 0.5} ${y1}, ${x2 - dx * 0.5} ${y2}, ${x2} ${y2}`);
    g.appendChild(path);
  }

  // Center
  const stageRect = stage.getBoundingClientRect();
  const tx = Math.max(20, (stageRect.width - width) / 2);
  const ty = Math.max(20, (stageRect.height - height) / 2);
  const initial = d3.zoomIdentity.translate(tx, ty).scale(1);
  if (state.zoom) d3.select(stage).call(state.zoom.transform, initial);
  else setTransform(initial);
}

async function main() {
  const res = await fetch("./state/graph.json", { cache: "no-store" });
  const data = await res.json();

  if (data.generated_at) meta.textContent = formatUpdated(data.generated_at);

  const zoom = d3.zoom().scaleExtent([0.25, 2.5]).on("zoom", (event) => setTransform(event.transform));
  state.zoom = zoom;
  d3.select(stage).call(zoom);

  if (data.nodes && data.edges) {
    renderDag(data);
  }
}

main().catch((e) => { meta.textContent = String(e); });
