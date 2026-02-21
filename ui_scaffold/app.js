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
      selectedNodeId: null,
      nodes: [],
      actions: DEFAULT_ACTIONS,
      connectedProject: null,
      connectedProjectHandle: null,
      connectError: null,
      isConnectingProject: false,
    };
  },
  computed: {
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
  },
  methods: {
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
        "border",
        "px-4",
        "py-3",
        "text-left",
        "transition",
        "duration-150",
        "hover:-translate-y-0.5",
        "hover:shadow-md",
        "bg-white",
        "text-gray-800",
        "border-gray-200",
        "shadow-sm",
      ];

      if (node.root) classes.push("border-amber-300");
      if (node.dirty) classes.push("border-red-300");
      if (node.warning && !node.dirty) classes.push("border-amber-300");
      if (node.id === this.selectedNodeId) classes.push("border-blue-400", "ring-1", "ring-blue-200", "shadow-blue-100");

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
      if (key === "t" && typeof this.toggleTheme === "function") {
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
