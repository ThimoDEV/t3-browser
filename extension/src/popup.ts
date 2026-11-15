import type { Session, Settings } from "./sessions";

interface PopupState {
  connected: boolean;
  settings: Settings;
  version: string;
  sessions: Array<Session & { tabs: Array<{ tabId: number; title?: string; url?: string; controlled: boolean }> }>;
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

function el(tag: string, props: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

async function action(payload: Record<string, unknown>) {
  await chrome.runtime.sendMessage({ kind: "popup-action", ...payload });
  await render();
}

async function render() {
  const state: PopupState = await chrome.runtime.sendMessage({ kind: "popup-state" });
  const status = $("#status");
  status.textContent = state.connected ? "Connected" : "Waiting for T3 Code";
  status.className = `status ${state.connected ? "on" : "off"}`;
  $("#version").textContent = `v${state.version}`;

  const list = $("#sessions");
  list.replaceChildren();
  for (const s of state.sessions) {
    const live = s.tabs.some((t) => t.controlled);
    const tabs = el("ul", { class: "tabs" });
    for (const t of s.tabs) {
      const item = el("li", { title: t.url ?? "" }, t.title || t.url || `Tab ${t.tabId}`);
      item.addEventListener("click", () => chrome.tabs.update(t.tabId, { active: true }));
      tabs.append(item);
    }
    const stop = el("button", { class: "ghost small" }, "Stop");
    stop.addEventListener("click", () => action({ action: "stop", sessionId: s.id }));
    if (!live) stop.setAttribute("disabled", "");
    list.append(
      el(
        "li",
        { class: "session" },
        el("div", { class: "row-head" }, el("strong", {}, s.title), el("span", { class: `pill ${live ? "on" : ""}` }, live ? "in control" : s.interrupted ? "stopped" : "idle"), stop),
        tabs,
      ),
    );
  }
  $("#no-sessions").hidden = state.sessions.length > 0;
  $("#stop-all").hidden = !state.sessions.some((s) => s.tabs.some((t) => t.controlled));

  $<HTMLInputElement>("#trusted").checked = state.settings.approvalMode === "trusted";
  const origins = $("#origins");
  origins.replaceChildren();
  for (const o of state.settings.alwaysAllowed) {
    const remove = el("button", { class: "ghost small", title: "Ask again next time" }, "Remove");
    remove.addEventListener("click", () =>
      action({ action: "settings", patch: { alwaysAllowed: state.settings.alwaysAllowed.filter((x) => x !== o) } }),
    );
    origins.append(el("li", { class: "row-head" }, el("span", {}, o.replace(/^https?:\/\//, "")), remove));
  }
}

$("#stop-all").addEventListener("click", () => action({ action: "stop-all" }));
$<HTMLInputElement>("#trusted").addEventListener("change", (e) =>
  action({ action: "settings", patch: { approvalMode: (e.target as HTMLInputElement).checked ? "trusted" : "ask" } }),
);

render();
setInterval(render, 2000);
