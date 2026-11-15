import type { ApprovalRequest } from "./sessions";

const id = new URLSearchParams(location.search).get("id") ?? "";
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

function decide(decision: "once" | "deny") {
  chrome.runtime.sendMessage({ kind: "approval-decide", id, decision });
  window.close();
}

chrome.runtime.sendMessage({ kind: "approval-get", id }).then((req: ApprovalRequest | null) => {
  if (!req) {
    $("#title").textContent = "This request has expired";
    $("#body").textContent = "The agent is no longer waiting for an answer.";
    document.querySelector(".actions")!.remove();
    return;
  }
  const who = `“${req.sessionTitle}”`;
  switch (req.kind) {
    case "tabs":
      $("#title").textContent = "Let T3 Code see your open tabs?";
      $("#body").textContent = `The agent in ${who} wants the titles and addresses of your open web tabs, for example to find one to work in.`;
      break;
    case "claim":
      $("#title").textContent = "Hand this tab to T3 Code?";
      $("#body").textContent = `The agent in ${who} wants to take over a tab you opened on ${req.origin}. It moves into the agent's tab group.`;
      $("#detail").textContent = req.detail ?? "";
      $("#detail").hidden = !req.detail;
      $("#once").textContent = "Hand it over";
      break;
    case "upload":
      $("#title").textContent = `Upload files to ${req.origin?.replace(/^https?:\/\//, "")}?`;
      $("#body").textContent = `The agent in ${who} wants to upload these files from your computer:`;
      $("#detail").textContent = req.detail ?? "";
      $("#detail").hidden = false;
      $("#once").textContent = "Upload";
      break;
  }
  document.title = `T3 Browser · ${$("#title").textContent}`;
});

$("#deny").addEventListener("click", () => decide("deny"));
$("#once").addEventListener("click", () => decide("once"));
document.addEventListener("keydown", (e) => e.key === "Escape" && decide("deny"));
