const { createApp } = Vue;

const DEFAULT_ACTIONS = [
  { key: "r", label: "refresh worktrees" },
  { key: "a", label: "create worktree" },
  { key: "f", label: "fetch + pull parent" },
  { key: "R", label: "rebase selected onto parent" },
  { key: "c", label: "add + commit" },
  { key: "p", label: "push" },
  { key: "d", label: "delete selected" },
  { key: "m", label: "merge to parent" },
];

function parseHeadBranch(headText, fallback) {
  const normalized = String(headText || "").trim();
  if (!normalized) return fallback;
  const refPrefix = "ref: refs/heads/";
  if (normalized.startsWith(refPrefix)) {
    return normalized.slice(refPrefix.length);
  }
  return "detached";
}

async function readTextFile(directoryHandle, fileName) {
  try {
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch (error) {
    return null;
  }
}

function parseWorktreePath(gitdirText, fallback) {
  const normalized = String(gitdirText || "").trim().replace(/\/$/, "");
  if (!normalized) return fallback;
  return normalized.endsWith("/.git") ? normalized.slice(0, -5) : normalized;
}

async function buildRepositoryNodes(projectHandle, gitDirectoryHandle) {
  const rootHeadText = await readTextFile(gitDirectoryHandle, "HEAD");
  const nodes = [
    {
      id: "root",
      branch: parseHeadBranch(rootHeadText, projectHandle.name),
      state: "repository connected",
      path: projectHandle.name,
      x: 430,
      y: 60,
      parentId: null,
      root: true,
      dirty: false,
      ahead: 0,
      behind: 0,
      warning: false,
    },
  ];

  let worktreesHandle = null;
  try {
    worktreesHandle = await gitDirectoryHandle.getDirectoryHandle("worktrees", { create: false });
  } catch (error) {
    worktreesHandle = null;
  }

  if (!worktreesHandle) return nodes;

  let index = 0;
  for await (const [name, handle] of worktreesHandle.entries()) {
    if (handle.kind !== "directory") continue;
    const gitdirText = await readTextFile(handle, "gitdir");
    const headText = await readTextFile(handle, "HEAD");
    const column = index % 4;
    const row = Math.floor(index / 4);
    nodes.push({
      id: `wt-${name}`,
      branch: parseHeadBranch(headText, name),
      state: "linked worktree",
      path: parseWorktreePath(gitdirText, name),
      x: 40 + column * 240,
      y: 240 + row * 160,
      parentId: "root",
      root: false,
      dirty: false,
      ahead: 0,
      behind: 0,
      warning: false,
    });
    index += 1;
  }

  return nodes;
}

function toNumber(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function normalizeNode(rawNode, index) {
  const id = String(rawNode?.id || `node-${index + 1}`);
  const branch = String(rawNode?.branch || rawNode?.name || id);
  const x = toNumber(rawNode?.x, 80 + (index % 4) * 230);
  const y = toNumber(rawNode?.y, 80 + Math.floor(index / 4) * 180);
  const ahead = Math.max(0, toNumber(rawNode?.ahead, 0));
  const behind = Math.max(0, toNumber(rawNode?.behind, 0));
  const parentId = rawNode?.parentId ? String(rawNode.parentId) : null;

  return {
    id,
    branch,
    state: String(rawNode?.state || "clean"),
    path: String(rawNode?.path || "-"),
    x,
    y,
    parentId,
    root: Boolean(rawNode?.root || !parentId),
    dirty: Boolean(rawNode?.dirty),
    ahead,
    behind,
    warning: Boolean(rawNode?.warning || behind > 0),
  };
}

function loadNodesFromWindow() {
  const payload = window.OPENSWARM_GRAPH_DATA;
  const rawNodes = Array.isArray(payload) ? payload : Array.isArray(payload?.nodes) ? payload.nodes : [];
  return rawNodes.map(normalizeNode);
}

function buildLinks(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => node.parentId)
    .map((node) => {
      const parent = byId.get(node.parentId);
      if (!parent) return null;
      const startX = parent.x + 70;
      const startY = parent.y + 34;
      const endX = node.x + 70;
      const endY = node.y;
      const middleY = (startY + endY) / 2;
      return `M${startX} ${startY} C${startX} ${middleY}, ${endX} ${middleY}, ${endX} ${endY}`;
    })
    .filter(Boolean);
}

createApp({
  data() {
    return {
      theme: "dark",
      bgModes: ["stars", "grid", "flat"],
      bgIndex: 0,
      selectedNodeId: null,
      nodes: [],
      actions: DEFAULT_ACTIONS,
      connectedProject: null,
      connectedProjectHandle: null,
      connectError: null,
      isConnectingProject: false,
      stars: [
        { id: 1, x: 4, y: 9, size: 1, opacity: 0.9 },
        { id: 2, x: 11, y: 24, size: 2, opacity: 0.6 },
        { id: 3, x: 18, y: 68, size: 1, opacity: 0.65 },
        { id: 4, x: 22, y: 41, size: 1, opacity: 0.7 },
        { id: 5, x: 29, y: 17, size: 2, opacity: 0.85 },
        { id: 6, x: 36, y: 88, size: 1, opacity: 0.8 },
        { id: 7, x: 43, y: 51, size: 2, opacity: 0.8 },
        { id: 8, x: 48, y: 30, size: 1, opacity: 0.6 },
        { id: 9, x: 57, y: 12, size: 1, opacity: 0.8 },
        { id: 10, x: 64, y: 72, size: 2, opacity: 0.75 },
        { id: 11, x: 71, y: 38, size: 1, opacity: 0.6 },
        { id: 12, x: 79, y: 10, size: 1, opacity: 0.92 },
        { id: 13, x: 85, y: 66, size: 2, opacity: 0.85 },
        { id: 14, x: 92, y: 28, size: 1, opacity: 0.88 },
        { id: 15, x: 96, y: 81, size: 1, opacity: 0.7 },
      ],
    };
  },
  computed: {
    bgMode() {
      return this.bgModes[this.bgIndex];
    },
    links() {
      return buildLinks(this.nodes);
    },
    selectedNode() {
      if (!this.nodes.length) return null;
      return this.nodes.find((node) => node.id === this.selectedNodeId) || this.nodes[0];
    },
    hasNodes() {
      return this.nodes.length > 0;
    },
    nodeStats() {
      return {
        total: this.nodes.length,
        dirty: this.nodes.filter((node) => node.dirty).length,
        ahead: this.nodes.filter((node) => node.ahead > 0).length,
        behind: this.nodes.filter((node) => node.behind > 0).length,
      };
    },
    cardClass() {
      return this.theme === "dark"
        ? "border-[#8d92ad] bg-[#22233a]/50"
        : "border-[#c3cad6] bg-[#f7f8fb]/80";
    },
    backgroundStyle() {
      if (this.theme === "dark" && this.bgMode === "stars") {
        return {
          background:
            "radial-gradient(circle at 15% 15%, #33355e 0%, transparent 30%), radial-gradient(circle at 80% 70%, #1c3757 0%, transparent 35%), #17162a",
        };
      }

      if (this.theme === "dark" && this.bgMode === "grid") {
        return {
          background:
            "radial-gradient(circle, rgba(124,162,237,0.24) 1px, transparent 1px), radial-gradient(circle at 15% 15%, #33355e 0%, transparent 30%), radial-gradient(circle at 80% 70%, #1c3757 0%, transparent 35%), #17162a",
          backgroundSize: "22px 22px, auto, auto, auto",
        };
      }

      if (this.theme === "light" && this.bgMode === "grid") {
        return {
          background: "radial-gradient(circle, rgba(127,139,164,0.25) 1px, transparent 1px), #eceef2",
          backgroundSize: "20px 20px",
        };
      }

      return {
        background: this.theme === "dark" ? "#17162a" : "#eceef2",
      };
    },
  },
  methods: {
    toggleTheme() {
      this.theme = this.theme === "dark" ? "light" : "dark";
    },
    cycleBackground() {
      this.bgIndex = (this.bgIndex + 1) % this.bgModes.length;
    },
    loadGraphData() {
      this.nodes = loadNodesFromWindow();
      this.selectedNodeId = this.nodes[0]?.id || null;
    },
    async refreshWorktrees() {
      if (!this.connectedProjectHandle) return;
      this.connectError = null;
      try {
        const gitHandle = await this.connectedProjectHandle.getDirectoryHandle(".git", { create: false });
        this.nodes = await buildRepositoryNodes(this.connectedProjectHandle, gitHandle);
        this.selectedNodeId = this.nodes[0]?.id || null;
        if (this.connectedProject) {
          this.connectedProject.worktreeCount = Math.max(0, this.nodes.length - 1);
        }
      } catch (error) {
        this.connectError = "Could not refresh worktrees from this repository.";
      }
    },
    async connectProject() {
      if (typeof window.showDirectoryPicker !== "function") {
        this.connectError = "Directory picker is not supported in this browser.";
        return;
      }

      this.isConnectingProject = true;
      this.connectError = null;

      try {
        const projectHandle = await window.showDirectoryPicker({ mode: "read" });
        let gitHandle = null;

        try {
          gitHandle = await projectHandle.getDirectoryHandle(".git", { create: false });
        } catch (error) {
          gitHandle = null;
        }

        if (!gitHandle) {
          this.connectedProject = null;
          this.nodes = [];
          this.selectedNodeId = null;
          this.connectError = `Folder \"${projectHandle.name}\" does not contain a .git directory.`;
          return;
        }

        this.connectedProject = {
          name: projectHandle.name,
          gitDirectoryName: gitHandle.name,
          worktreeCount: 0,
        };
        this.connectedProjectHandle = projectHandle;
        await this.refreshWorktrees();
      } catch (error) {
        if (error?.name !== "AbortError") {
          this.connectError = "Could not open folder. Try again.";
        }
      } finally {
        this.isConnectingProject = false;
      }
    },
    setSelected(nodeId) {
      this.selectedNodeId = nodeId;
    },
    nodeStyle(node) {
      return { left: `${node.x}px`, top: `${node.y}px` };
    },
    nodeClass(node) {
      const classes = [
        "absolute",
        "min-w-[140px]",
        "rounded-lg",
        "border-2",
        "px-3",
        "py-2",
        "text-left",
        "shadow",
        "transition",
        "duration-150",
        "hover:-translate-y-px",
      ];

      if (this.theme === "dark") {
        classes.push("bg-[#1e1f34]/95", "text-[#e8ecff]", "border-[#c6c9d8]");
      } else {
        classes.push("bg-[#fafbfc]/90", "text-[#1c2534]", "border-[#97a1af]");
      }

      if (node.root) classes.push("border-[#e0b787]");
      if (node.dirty) classes.push("border-[#ff4d4d]");
      if (node.warning) classes.push("border-[#d7a55a]");
      if (node.id === this.selectedNodeId) classes.push("border-[#259cff]");

      return classes;
    },
    onCanvasKeydown(event) {
      if (event.key === "j") {
        event.preventDefault();
        this.moveSelection(1);
      }
      if (event.key === "k") {
        event.preventDefault();
        this.moveSelection(-1);
      }
    },
    moveSelection(direction) {
      if (!this.nodes.length) return;
      const currentIndex = this.nodes.findIndex((node) => node.id === this.selectedNodeId);
      const nextIndex = Math.min(this.nodes.length - 1, Math.max(0, currentIndex + direction));
      this.selectedNodeId = this.nodes[nextIndex].id;
    },
    onGlobalKeydown(event) {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "b") {
        event.preventDefault();
        this.cycleBackground();
      }

      if (key === "t") {
        this.toggleTheme();
      }

      if (key === "j") {
        this.moveSelection(1);
      }

      if (key === "k") {
        this.moveSelection(-1);
      }

      if (key === "r") {
        this.refreshWorktrees();
      }
    },
  },
  mounted() {
    this.loadGraphData();
    window.addEventListener("keydown", this.onGlobalKeydown);
  },
  beforeUnmount() {
    window.removeEventListener("keydown", this.onGlobalKeydown);
  },
}).mount("#app");
