// Turns a CDP accessibility tree into the compact, ref-annotated text format popularised by
// agent-browser:  `- link "Learn more" [ref=e1]`.  Pure function so it can be unit-tested.

export interface AXValue {
  type?: string;
  value?: unknown;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  description?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface SnapshotOptions {
  /** Only list elements that get a ref, flat. */
  interactive?: boolean;
  /** Stop descending below this depth (0 = root's children). */
  maxDepth?: number;
  /** Hard cap on output size; the tail is replaced with a note. */
  maxChars?: number;
}

export interface RefTarget {
  backendNodeId: number;
  role: string;
  name: string;
}

/** Allocates refs. Reusing the allocator keeps a node's ref stable across snapshots. */
export class RefAllocator {
  private byNode = new Map<number, string>();
  private next = 1;
  readonly targets = new Map<string, RefTarget>();

  refFor(target: RefTarget): string {
    let ref = this.byNode.get(target.backendNodeId);
    if (!ref) {
      ref = `e${this.next++}`;
      this.byNode.set(target.backendNodeId, ref);
    }
    this.targets.set(ref, target);
    return ref;
  }

  /** Forget refs whose node did not appear in the latest snapshot. */
  retainOnly(refs: Set<string>): void {
    for (const [ref, t] of this.targets) {
      if (!refs.has(ref)) {
        this.targets.delete(ref);
        this.byNode.delete(t.backendNodeId);
      }
    }
  }

  reset(): void {
    this.byNode.clear();
    this.targets.clear();
    this.next = 1;
  }
}

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "listbox",
  "treeitem",
  "PopUpButton",
  "ComboBoxMenuButton",
  "ComboBoxSelect",
  "DisclosureTriangle",
  "ToggleButton",
  "colorwell",
  "date",
  "DateTime",
  "InputTime",
  "textField",
]);

/** Roles that only add nesting noise; their children are promoted. */
const TRANSPARENT_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "GenericContainer",
  "LabelText",
  "RootWebArea",
  "WebArea",
  "Section",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
  "Pre",
  "Ruby",
  "Canvas",
]);

const DROPPED_ROLES = new Set(["InlineTextBox", "LineBreak"]);

const BOOLEAN_STATES = ["disabled", "required", "focused", "readonly", "modal", "multiselectable"] as const;

function str(v: AXValue | undefined): string {
  if (!v || v.value === undefined || v.value === null) return "";
  return String(v.value);
}

function prop(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

function quote(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  const cut = oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
  return JSON.stringify(cut);
}

function stateTags(node: AXNode): string[] {
  const tags: string[] = [];
  const checked = prop(node, "checked");
  if (checked === "true" || checked === true) tags.push("checked");
  else if (checked === "mixed") tags.push("checked=mixed");
  const pressed = prop(node, "pressed");
  if (pressed === "true" || pressed === true) tags.push("pressed");
  const selected = prop(node, "selected");
  if (selected === true || selected === "true") tags.push("selected");
  const expanded = prop(node, "expanded");
  if (expanded !== undefined) tags.push(expanded === true || expanded === "true" ? "expanded" : "collapsed");
  for (const s of BOOLEAN_STATES) {
    const v = prop(node, s);
    if (v === true || v === "true") tags.push(s);
  }
  const level = prop(node, "level");
  if (level !== undefined) tags.push(`level=${level}`);
  return tags;
}

function isInteractive(node: AXNode, role: string): boolean {
  if (INTERACTIVE_ROLES.has(role)) return true;
  // Elements made focusable by the page (custom widgets, clickable cards) also deserve a ref.
  return prop(node, "focusable") === true && !!str(node.name) && !TRANSPARENT_ROLES.has(role) && role !== "RootWebArea";
}

export interface FormatResult {
  text: string;
  refs: Set<string>;
  truncated: boolean;
}

/**
 * Format one tree. `frames` lets the caller graft iframe documents in at their Iframe node
 * (keyed by the iframe element's backendDOMNodeId).
 */
export function formatAXTree(
  nodes: AXNode[],
  refs: RefAllocator,
  opts: SnapshotOptions = {},
  frames: Map<number, AXNode[]> = new Map(),
): FormatResult {
  const maxChars = opts.maxChars ?? 60_000;
  const lines: string[] = [];
  const used = new Set<string>();
  let size = 0;
  let truncated = false;

  const emit = (line: string) => {
    if (truncated) return;
    if (size + line.length + 1 > maxChars) {
      truncated = true;
      return;
    }
    lines.push(line);
    size += line.length + 1;
  };

  const walkTree = (treeNodes: AXNode[], baseDepth: number): string[] => {
    const byId = new Map(treeNodes.map((n) => [n.nodeId, n]));
    const root = treeNodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? treeNodes[0];
    if (!root) return [];

    const norm = (s: string) => s.replace(/\s+/g, " ").trim();

    /**
     * Returns the lines for this subtree. `skipText` holds strings already said by the parent
     * or a sibling (a label next to its own textbox), so they are not repeated.
     */
    const visit = (node: AXNode, depth: number, skipText: Set<string>): string[] => {
      const role = str(node.role);
      if (DROPPED_ROLES.has(role)) return [];
      const name = str(node.name);
      const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AXNode => !!c);

      if (role === "StaticText") {
        const t = norm(name);
        return !opts.interactive && t && !skipText.has(t) ? [`${"  ".repeat(depth)}- StaticText ${quote(name, 300)}`] : [];
      }

      const transparent = node.ignored || (TRANSPARENT_ROLES.has(role) && !name) || role === "RootWebArea";
      let own: string | null = null;
      let interactive = false;
      let childDepth = depth;
      let childSkip = skipText;
      if (!transparent) {
        interactive = node.backendDOMNodeId !== undefined && isInteractive(node, role);
        if (!opts.interactive || interactive) {
          let line = `${opts.interactive ? "" : "  ".repeat(depth)}- ${role}`;
          if (name) line += ` ${quote(name)}`;
          if (interactive) {
            const ref = refs.refFor({ backendNodeId: node.backendDOMNodeId!, role, name });
            used.add(ref);
            line += ` [ref=${ref}]`;
          }
          const tags = stateTags(node);
          if (tags.length) line += ` [${tags.join(", ")}]`;
          const value = str(node.value);
          if (value && value !== name) line += ` value=${quote(value, 120)}`;
          const url = prop(node, "url");
          if (role === "link" && typeof url === "string" && url && !opts.interactive) line += ` → ${url.slice(0, 160)}`;
          own = line;
        }
        childDepth = depth + 1;
        childSkip = new Set(name ? [norm(name)] : []);
      }

      let below: string[] = [];
      if (opts.maxDepth === undefined || childDepth - baseDepth <= opts.maxDepth) {
        if (role === "Iframe" && node.backendDOMNodeId !== undefined) {
          const frameNodes = frames.get(node.backendDOMNodeId);
          if (frameNodes) below = walkTree(frameNodes, childDepth);
        } else {
          const siblingNames = new Set(childSkip);
          for (const c of children) if (str(c.role) !== "StaticText" && str(c.name)) siblingNames.add(norm(str(c.name)));
          for (const c of children) below.push(...visit(c, childDepth, siblingNames));
        }
      }

      // Unnamed structure with nothing inside it is noise ("- paragraph", "- list").
      if (own && !interactive && !name && !str(node.value) && below.length === 0 && !stateTags(node).length) own = null;
      return own ? [own, ...below] : below;
    };

    return visit(root, baseDepth, new Set());
  };

  for (const line of walkTree(nodes, 0)) {
    emit(line);
    if (truncated) break;
  }
  if (truncated) lines.push(`… snapshot truncated at ${maxChars} chars; use interactive mode or a smaller scope`);
  return { text: lines.join("\n"), refs: used, truncated };
}
