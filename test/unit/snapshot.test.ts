import { describe, expect, it } from "vitest";
import { formatAXTree, RefAllocator, type AXNode } from "../../extension/src/snapshot";

let id = 0;
function n(role: string, name = "", extra: Partial<AXNode> = {}, children: AXNode[] = []): AXNode[] {
  const nodeId = String(++id);
  const self: AXNode = { nodeId, role: { value: role }, name: { value: name }, backendDOMNodeId: 1000 + id, childIds: [], ...extra };
  const flat: AXNode[] = [self];
  for (const c of children) {
    const [root, ...rest] = c as unknown as AXNode[];
    root.parentId = nodeId;
    self.childIds!.push(root.nodeId);
    flat.push(root, ...rest);
  }
  return flat;
}
const tree = (...nodes: AXNode[][]) => nodes as unknown as AXNode[];

describe("formatAXTree", () => {
  it("prints agent-browser style lines with refs on interactive elements only", () => {
    const nodes = n("RootWebArea", "Page", {}, tree(n("heading", "Signup", { properties: [{ name: "level", value: { value: 1 } }] }), n("textbox", "Name"), n("button", "Send")));
    const { text } = formatAXTree(nodes, new RefAllocator());
    expect(text).toBe(['- heading "Signup" [level=1]', '- textbox "Name" [ref=e1]', '- button "Send" [ref=e2]'].join("\n"));
  });

  it("drops StaticText children that only repeat the parent's name", () => {
    const nodes = n("RootWebArea", "", {}, tree(n("link", "Learn more", {}, tree(n("StaticText", "Learn more")))));
    expect(formatAXTree(nodes, new RefAllocator()).text).toBe('- link "Learn more" [ref=e1]');
  });

  it("promotes children of ignored and unnamed generic nodes", () => {
    const nodes = n("RootWebArea", "", {}, tree(n("generic", "", {}, tree(n("generic", "", { ignored: true }, tree(n("button", "Deep")))))));
    expect(formatAXTree(nodes, new RefAllocator()).text).toBe('- button "Deep" [ref=e1]');
  });

  it("shows states and values", () => {
    const nodes = n(
      "RootWebArea",
      "",
      {},
      tree(
        n("checkbox", "Agree", { properties: [{ name: "checked", value: { value: "true" } }] }),
        n("textbox", "Email", { value: { value: "a@b.c" }, properties: [{ name: "required", value: { value: true } }] }),
        n("button", "Menu", { properties: [{ name: "expanded", value: { value: false } }, { name: "disabled", value: { value: true } }] }),
      ),
    );
    expect(formatAXTree(nodes, new RefAllocator()).text).toBe(
      ['- checkbox "Agree" [ref=e1] [checked]', '- textbox "Email" [ref=e2] [required] value="a@b.c"', '- button "Menu" [ref=e3] [collapsed, disabled]'].join("\n"),
    );
  });

  it("does not repeat a label next to the field it names, and drops empty structure", () => {
    const nodes = n(
      "RootWebArea",
      "",
      {},
      tree(n("LabelText", "", {}, tree(n("StaticText", "Name"), n("textbox", "Name"))), n("paragraph", ""), n("paragraph", "", {}, tree(n("StaticText", "Real text")))),
    );
    expect(formatAXTree(nodes, new RefAllocator()).text).toBe(['- textbox "Name" [ref=e1]', "- paragraph", '  - StaticText "Real text"'].join("\n"));
  });

  it("interactive mode is flat and omits text", () => {
    const nodes = n("RootWebArea", "", {}, tree(n("navigation", "Main", {}, tree(n("link", "Home"), n("StaticText", "hello")))));
    expect(formatAXTree(nodes, new RefAllocator(), { interactive: true }).text).toBe('- link "Home" [ref=e1]');
  });

  it("keeps refs stable across snapshots for the same DOM node", () => {
    const refs = new RefAllocator();
    const nodes = n("RootWebArea", "", {}, tree(n("button", "A"), n("button", "B")));
    formatAXTree(nodes, refs);
    const again = formatAXTree(nodes.slice().reverse().reverse(), refs);
    expect(again.text).toContain('button "B" [ref=e2]');
    expect(refs.targets.get("e2")?.name).toBe("B");
  });

  it("gives focusable custom widgets a ref", () => {
    const nodes = n("RootWebArea", "", {}, tree(n("article", "Card title", { properties: [{ name: "focusable", value: { value: true } }] })));
    expect(formatAXTree(nodes, new RefAllocator()).text).toBe('- article "Card title" [ref=e1]');
  });

  it("grafts iframe documents under their Iframe node", () => {
    const outer = n("RootWebArea", "", {}, tree(n("Iframe", "")));
    const iframe = outer.find((x) => x.role?.value === "Iframe")!;
    const inner = n("RootWebArea", "Frame", {}, tree(n("button", "Inside")));
    const { text } = formatAXTree(outer, new RefAllocator(), {}, new Map([[iframe.backendDOMNodeId!, inner]]));
    expect(text).toBe(['- Iframe', '  - button "Inside" [ref=e1]'].join("\n"));
  });

  it("truncates instead of blowing up the context", () => {
    const many = n("RootWebArea", "", {}, tree(...Array.from({ length: 500 }, (_, i) => n("button", `Button number ${i}`))));
    const r = formatAXTree(many, new RefAllocator(), { maxChars: 1000 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(1200);
    expect(r.text).toMatch(/snapshot truncated/);
  });
});
