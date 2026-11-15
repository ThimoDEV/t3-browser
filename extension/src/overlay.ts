// Injected into tabs an agent is controlling. Shows that T3 Code is in control, draws the
// agent's own animated mouse cursor (it glides to each target and shows the click before the
// real input is sent), and lets the user take the tab back with Esc. Lives in a closed
// shadow root with aria-hidden and pointer-events: none, so it never shows up in the agent's
// accessibility snapshot and never catches a click.

interface Point {
  x: number;
  y: number;
}

interface OverlayApi {
  /** Build that injected this overlay. */
  build?: string;
  /** `hasLink`: the label opens the thread in T3 Code. */
  show(label: string, hasLink?: boolean): void;
  hide(): void;
  /** Glide the agent cursor to (x, y), starting from `from` (or the control pill). Resolves on arrival. */
  moveTo(x: number, y: number, from: Point | null, activity: string | null): Promise<void>;
  /** Press animation and ripple at (x, y). */
  click(x: number, y: number): void;
  /** Text next to the cursor ("Typing…"); null for the plain "T3 Code" tag. */
  activity(text: string | null): void;
  /** Older builds' click marker; same as click(). */
  pulse(x: number, y: number): void;
  /** The agent is about to send input: ignore Esc and let clicks pass through the pill. */
  agentActing(ms: number): void;
}

declare global {
  interface Window {
    __t3BrowserOverlay?: OverlayApi;
  }
}

declare const __VERSION__: string;
// Changes with every build, so a reloaded extension replaces the overlay an older build left in
// the page (content scripts share one world per extension across reloads).
const BUILD = `${__VERSION__}+${__BUILD_ID__}`;
declare const __BUILD_ID__: string;

(() => {
  if (window.top !== window) return;
  const existing = window.__t3BrowserOverlay;
  if (existing?.build === BUILD) return;
  if (existing) {
    try {
      existing.hide();
    } catch {
      // an orphaned overlay from an old build may throw; its element is removed below anyway
    }
    document.querySelectorAll("t3-browser-overlay").forEach((el) => el.remove());
  }

  const host = document.createElement("t3-browser-overlay");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .frame {
        position: fixed; inset: 0; pointer-events: none;
        box-shadow: inset 0 0 0 2px rgba(124, 92, 255, .9), inset 0 0 28px 4px rgba(124, 92, 255, .35);
        animation: breathe 2.4s ease-in-out infinite;
      }
      @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(124,92,255,.65), inset 0 0 40px 8px rgba(124,92,255,.22); } }
      .pill {
        position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px;
        font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #f5f3ff; background: rgba(24, 20, 38, .92);
        border: 1px solid rgba(124, 92, 255, .6); border-radius: 999px;
        padding: 9px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        pointer-events: auto; user-select: none;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #8b6cff; box-shadow: 0 0 0 0 rgba(139,108,255,.7); animation: ping 1.6s infinite; }
      @keyframes ping { 70% { box-shadow: 0 0 0 8px rgba(139,108,255,0); } 100% { box-shadow: 0 0 0 0 rgba(139,108,255,0); } }
      kbd { font: 600 11px/1 ui-monospace, monospace; background: rgba(255,255,255,.12); border-radius: 4px; padding: 3px 5px; }
      button { all: unset; cursor: pointer; color: #c4b5fd; font-weight: 600; }
      button:hover { color: #fff; }
      .label.link { cursor: pointer; text-decoration: underline; text-decoration-color: rgba(196,181,253,.5); text-underline-offset: 3px; }
      .label.link:hover { color: #fff; }

      /* The agent's cursor. Its tip sits exactly on the point the agent acts on. */
      .cursor {
        position: fixed; left: 0; top: 0; pointer-events: none;
        opacity: 0; transition: opacity .2s ease;
        will-change: transform;
      }
      .cursor.on { opacity: 1; }
      .arrow {
        display: block; width: 22px; height: 26px; transform-origin: 2px 2px;
        filter: drop-shadow(0 2px 4px rgba(20, 10, 50, .45));
      }
      .tag {
        position: absolute; left: 18px; top: 22px; white-space: nowrap;
        font: 600 11px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #fff; background: #6d4aff; border-radius: 999px 999px 999px 4px;
        padding: 5px 8px; box-shadow: 0 2px 8px rgba(20, 10, 50, .35);
      }
      .tag .dots::after { content: ""; animation: dots 1.2s steps(4) infinite; }
      @keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
      .ripple {
        position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 2px solid rgba(139, 108, 255, .9); background: rgba(139, 108, 255, .22);
        pointer-events: none;
      }
      .hidden { display: none !important; }
    </style>
    <div class="frame"></div>
    <div class="cursor">
      <svg class="arrow" viewBox="0 0 22 26" aria-hidden="true">
        <path d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15 L18 15 Z"
              fill="#7c5cff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" />
      </svg>
      <span class="tag"><span class="text">T3 Code</span><span class="dots"></span></span>
    </div>
    <div class="pill"><span class="dot"></span><span class="label"></span><kbd>Esc</kbd><button type="button">Stop</button></div>
  `;
  const frame = root.querySelector(".frame") as HTMLElement;
  const pill = root.querySelector(".pill") as HTMLElement;
  const label = root.querySelector(".label") as HTMLElement;
  const cursor = root.querySelector(".cursor") as HTMLElement;
  const arrow = root.querySelector(".arrow") as SVGElement;
  const tagText = root.querySelector(".tag .text") as HTMLElement;
  const tagDots = root.querySelector(".tag .dots") as HTMLElement;
  const stop = root.querySelector("button") as HTMLButtonElement;

  let visible = false;
  let escSuppressedUntil = 0;
  let passthroughTimer = 0;
  let at: Point | null = null;
  let glide: Animation | null = null;

  const interrupt = (reason: string) => {
    chrome.runtime.sendMessage({ kind: "interrupt", reason }).catch(() => {});
  };

  stop.addEventListener("click", () => interrupt("stop-button"));
  label.addEventListener("click", () => {
    if (label.classList.contains("link")) chrome.runtime.sendMessage({ kind: "open-thread" }).catch(() => {});
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!visible || e.key !== "Escape" || !e.isTrusted) return;
      // The agent itself may press Escape through CDP; those presses are announced first.
      if (Date.now() < escSuppressedUntil) return;
      interrupt("escape");
    },
    true,
  );

  const mount = () => {
    if (!host.isConnected) (document.documentElement ?? document.body)?.appendChild(host);
  };

  const place = (p: Point) => {
    cursor.style.transform = `translate(${p.x}px, ${p.y}px)`;
  };

  // Nobody can watch a background tab (and Chrome barely runs its animations), so the cursor
  // just jumps there. Same for users who asked for less motion.
  const animate = () => !document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches;

  const setActivity = (text: string | null) => {
    tagText.textContent = text ?? "T3 Code";
    tagDots.classList.toggle("hidden", !text);
  };
  setActivity(null);

  const click = (x: number, y: number) => {
    if (!visible) return;
    place({ x, y });
    at = { x, y };
    cursor.classList.add("on");
    if (!animate()) return;
    arrow.animate([{ transform: "scale(1)" }, { transform: "scale(.78)" }, { transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
    const ripple = document.createElement("div");
    ripple.className = "ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    root.appendChild(ripple);
    ripple
      .animate([{ transform: "scale(.3)", opacity: 1 }, { transform: "scale(1.6)", opacity: 0 }], { duration: 520, easing: "cubic-bezier(.2,.7,.3,1)" })
      .finished.finally(() => ripple.remove());
  };

  window.__t3BrowserOverlay = {
    build: BUILD,
    show(text: string, hasLink?: boolean) {
      label.textContent = text;
      label.classList.toggle("link", !!hasLink);
      label.title = hasLink ? "Open this thread in T3 Code" : "";
      visible = true;
      frame.classList.remove("hidden");
      pill.classList.remove("hidden");
      mount();
    },
    hide() {
      visible = false;
      host.remove();
    },
    async moveTo(x: number, y: number, from: Point | null, activity: string | null) {
      if (!visible) return;
      setActivity(activity);
      const to = { x, y };
      // A fresh page starts the cursor where it was on the previous page, or at the pill.
      const start = at ?? from ?? { x: innerWidth / 2, y: innerHeight - 48 };
      at = to;
      glide?.cancel();
      cursor.classList.add("on");
      const dist = Math.hypot(to.x - start.x, to.y - start.y);
      if (!animate() || dist < 2) {
        place(to);
        return;
      }
      // A slight arc reads as a hand moving a mouse rather than a straight robotic line.
      const bend = Math.min(70, dist * 0.18);
      const mid = {
        x: (start.x + to.x) / 2 + (-(to.y - start.y) / dist) * bend,
        y: (start.y + to.y) / 2 + ((to.x - start.x) / dist) * bend,
      };
      const duration = Math.round(260 + Math.min(440, dist * 0.55));
      const tf = (p: Point) => `translate(${p.x}px, ${p.y}px)`;
      place(to);
      glide = cursor.animate(
        [{ transform: tf(start) }, { transform: tf(mid), offset: 0.5 }, { transform: tf(to) }],
        { duration, easing: "cubic-bezier(.45,.05,.25,1)" },
      );
      // Never wait longer than planned, even if the tab is hidden mid-way.
      await Promise.race([glide.finished.catch(() => {}), new Promise((r) => setTimeout(r, duration + 120))]);
    },
    click,
    pulse: click,
    activity: setActivity,
    agentActing(ms: number) {
      escSuppressedUntil = Date.now() + ms;
      pill.style.pointerEvents = "none";
      clearTimeout(passthroughTimer);
      passthroughTimer = window.setTimeout(() => (pill.style.pointerEvents = ""), ms);
    },
  };

  // Single-page apps sometimes replace <html> children wholesale; keep the overlay attached.
  new MutationObserver(() => visible && window.__t3BrowserOverlay?.build === BUILD && mount()).observe(document, { childList: true, subtree: false });
})();

export {};
