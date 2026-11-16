// Injected into tabs an agent is controlling. Shows that T3 Code is in control, draws the
// agent's own animated mouse cursor (it glides to each target and shows the click before the
// real input is sent), and lets the user take the tab back with Esc. Once the user has the tab
// (Esc, Stop, or the agent handed it over), a small card offers Hand back with a note for the
// agent. Lives in a closed shadow root with aria-hidden and pointer-events: none (except the
// pill and the card), so it never shows up in the agent's accessibility snapshot and never
// catches a click meant for the page.

interface Point {
  x: number;
  y: number;
}

interface OverlayApi {
  /** Build that injected this overlay. */
  build?: string;
  /** `hasLink`: the label opens the thread in T3 Code. */
  show(label: string, hasLink?: boolean, color?: string, tag?: string, ink?: string): void;
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
  /** The user has the tab: replace the agent's overlay with the Hand back card. */
  yourTurn(opts: YourTurn): void;
  /** The note went to the thread: say so briefly, then go away. */
  handedBack(text: string): void;
}

interface YourTurn {
  label: string;
  hasLink: boolean;
  color?: string;
  ink?: string;
  /** What the agent asked the user to do, if it handed the tab over. */
  ask?: string;
  /** False outside a T3 Code thread: there is nowhere to post a note. */
  canSend: boolean;
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
      :host { all: initial; --t3: #7c5cff; --t3-ink: #fff; }
      .arrow path { fill: var(--t3); }
      .frame {
        position: fixed; inset: 0; pointer-events: none;
        box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--t3) 90%, transparent), inset 0 0 28px 4px color-mix(in srgb, var(--t3) 35%, transparent);
        animation: breathe 2.4s ease-in-out infinite;
      }
      @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--t3) 65%, transparent), inset 0 0 40px 8px color-mix(in srgb, var(--t3) 22%, transparent); } }
      /* Nobody can click the pill in a hidden tab: let the agent's clicks pass through it. */
      :host(.hidden-tab) .pill { pointer-events: none; }
      .pill {
        position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        display: flex; align-items: center; gap: 10px;
        font: 500 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #f5f3ff; background: rgba(24, 20, 38, .92);
        border: 1px solid color-mix(in srgb, var(--t3) 60%, transparent); border-radius: 999px;
        padding: 9px 14px; box-shadow: 0 6px 24px rgba(0,0,0,.35);
        pointer-events: auto; user-select: none;
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--t3); box-shadow: 0 0 0 0 color-mix(in srgb, var(--t3) 70%, transparent); animation: ping 1.6s infinite; }
      @keyframes ping { 70% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--t3) 0%, transparent); } 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--t3) 0%, transparent); } }
      kbd { font: 600 11px/1 ui-monospace, monospace; background: rgba(255,255,255,.12); border-radius: 4px; padding: 3px 5px; }
      button { all: unset; cursor: pointer; color: color-mix(in srgb, var(--t3) 45%, #fff); font-weight: 600; }
      button:hover { color: #fff; }
      .label.link { cursor: pointer; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--t3) 50%, transparent); text-underline-offset: 3px; }
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
        color: var(--t3-ink); background: var(--t3); border-radius: 999px 999px 999px 4px;
        padding: 5px 8px; box-shadow: 0 2px 8px rgba(20, 10, 50, .35);
      }
      .tag .dots::after { content: ""; animation: dots 1.2s steps(4) infinite; }
      @keyframes dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
      .ripple {
        position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--t3) 90%, transparent); background: color-mix(in srgb, var(--t3) 22%, transparent);
        pointer-events: none;
      }
      /* The user's turn: a quiet card instead of the frame and cursor. */
      .turn {
        position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
        width: min(460px, calc(100vw - 32px)); box-sizing: border-box;
        font: 400 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
        color: #f5f3ff; background: rgba(24, 20, 38, .96);
        border: 1px solid color-mix(in srgb, var(--t3) 60%, transparent); border-radius: 14px;
        padding: 10px 12px 12px; box-shadow: 0 8px 28px rgba(0,0,0,.4);
        pointer-events: auto;
      }
      .turn-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
      .turn-head .dot { animation: none; }
      .turn-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: color-mix(in srgb, var(--t3) 35%, #fff); }
      .turn-label.link { cursor: pointer; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--t3) 50%, transparent); text-underline-offset: 3px; }
      .turn-label.link:hover { color: #fff; }
      .x { font-size: 15px; line-height: 1; padding: 2px 4px; color: rgba(255,255,255,.6); }
      .ask { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .send { display: flex; gap: 8px; margin-top: 8px; }
      .note {
        all: unset; flex: 1; min-width: 0; box-sizing: border-box; padding: 7px 10px; border-radius: 8px;
        background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16); color: #fff; font: inherit;
      }
      .note:focus { border-color: var(--t3); }
      .note::placeholder { color: rgba(255,255,255,.5); }
      .give { padding: 7px 12px; border-radius: 8px; background: var(--t3); color: var(--t3-ink); white-space: nowrap; }
      .give:hover { color: var(--t3-ink); filter: brightness(1.1); }
      .give[disabled] { opacity: .6; cursor: default; }
      .msg { margin: 6px 0 0; color: rgba(255,255,255,.75); }
      .msg.err { color: #fca5a5; }
      .msg:empty { display: none; }
      .hidden { display: none !important; }
    </style>
    <div class="frame"></div>
    <div class="cursor">
      <svg class="arrow" viewBox="0 0 22 26" aria-hidden="true">
        <path d="M2 2 L2 21 L7.2 16.4 L10.6 24 L14 22.5 L10.7 15 L18 15 Z"
              stroke="#fff" stroke-width="1.6" stroke-linejoin="round" />
      </svg>
      <span class="tag"><span class="text">T3 Code</span><span class="dots"></span></span>
    </div>
    <div class="pill"><span class="dot"></span><span class="label"></span><kbd>Esc</kbd><button type="button">Stop</button></div>
    <div class="turn hidden" role="dialog" aria-label="T3 Code: your turn">
      <div class="turn-head"><span class="dot"></span><span>Your turn</span><span class="turn-label"></span><button class="x" type="button" title="Dismiss" aria-label="Dismiss">✕</button></div>
      <p class="ask"></p>
      <form class="send"><input class="note" type="text" maxlength="2000" autocomplete="off" placeholder="Note for the agent (optional)" aria-label="Note for the agent"><button class="give" type="submit">Hand back</button></form>
      <p class="msg"></p>
    </div>
  `;
  const frame = root.querySelector(".frame") as HTMLElement;
  const pill = root.querySelector(".pill") as HTMLElement;
  const label = root.querySelector(".label") as HTMLElement;
  const cursor = root.querySelector(".cursor") as HTMLElement;
  const arrow = root.querySelector(".arrow") as SVGElement;
  const tagText = root.querySelector(".tag .text") as HTMLElement;
  const tagDots = root.querySelector(".tag .dots") as HTMLElement;
  const stop = root.querySelector(".pill button") as HTMLButtonElement;
  const turn = root.querySelector(".turn") as HTMLElement;
  const turnLabel = root.querySelector(".turn-label") as HTMLElement;
  const ask = root.querySelector(".ask") as HTMLElement;
  const sendForm = root.querySelector(".send") as HTMLFormElement;
  const note = root.querySelector(".note") as HTMLInputElement;
  const give = root.querySelector(".give") as HTMLButtonElement;
  const msg = root.querySelector(".msg") as HTMLElement;
  const dismiss = root.querySelector(".x") as HTMLButtonElement;

  let visible = false;
  /** The Hand back card is up. */
  let turnOn = false;
  let turnTimer = 0;
  let restingTag = "T3 Code";
  let escSuppressedUntil = 0;
  let passthroughTimer = 0;
  let at: Point | null = null;
  let glide: Animation | null = null;

  const interrupt = (reason: string) => {
    chrome.runtime.sendMessage({ kind: "interrupt", reason }).catch(() => {});
  };

  stop.addEventListener("click", () => interrupt("stop-button"));
  const openThread = (el: HTMLElement) => () => {
    if (el.classList.contains("link")) chrome.runtime.sendMessage({ kind: "open-thread" }).catch(() => {});
  };
  label.addEventListener("click", openThread(label));
  turnLabel.addEventListener("click", openThread(turnLabel));

  // Typing a note must not trigger the page's own shortcuts (GitHub's "s", "/", ...): keys
  // stay inside the card.
  for (const type of ["keydown", "keyup", "keypress", "beforeinput", "input", "paste"]) turn.addEventListener(type, (e) => e.stopPropagation());
  sendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    give.disabled = true;
    msg.className = "msg";
    msg.textContent = "Sending…";
    const r = (await chrome.runtime.sendMessage({ kind: "handback", note: note.value }).catch((err: unknown) => ({ error: String((err as Error)?.message ?? err) }))) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (r?.ok) return; // handedBack() shows the confirmation
    give.disabled = false;
    msg.className = "msg err";
    msg.textContent = r?.error ?? "Could not reach T3 Browser.";
  });
  dismiss.addEventListener("click", () => {
    chrome.runtime.sendMessage({ kind: "handback-dismiss" }).catch(() => {});
    window.__t3BrowserOverlay?.hide();
  });

  const setColors = (color?: string, ink?: string) => {
    if (color && /^#[0-9a-f]{6}$/i.test(color)) host.style.setProperty("--t3", color);
    if (ink && /^#[0-9a-f]{6}$/i.test(ink)) host.style.setProperty("--t3-ink", ink);
  };
  const closeTurn = () => {
    turnOn = false;
    clearTimeout(turnTimer);
    turn.classList.add("hidden");
  };
  window.addEventListener(
    "keydown",
    (e) => {
      // A hidden tab cannot have the user's keystrokes: an Escape there is the agent's own key.
      if (!visible || document.hidden || e.key !== "Escape" || !e.isTrusted) return;
      // The agent itself may press Escape through CDP; those presses are announced first.
      if (Date.now() < escSuppressedUntil) return;
      interrupt("escape");
    },
    true,
  );

  const trackVisibility = () => host.classList.toggle("hidden-tab", document.hidden);
  trackVisibility();
  document.addEventListener("visibilitychange", trackVisibility);

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
    tagText.textContent = text ?? restingTag;
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
    show(text: string, hasLink?: boolean, color?: string, tag?: string, ink?: string) {
      // The thread's colour and number, so two threads' tabs never look alike.
      setColors(color, ink);
      closeTurn();
      if (tag) restingTag = tag;
      setActivity(null);
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
      closeTurn();
      host.remove();
    },
    yourTurn(o: YourTurn) {
      // The agent's overlay goes: no frame, cursor or Esc. The card stays until the user acts.
      visible = false;
      glide?.cancel();
      cursor.classList.remove("on");
      frame.classList.add("hidden");
      pill.classList.add("hidden");
      setColors(o.color, o.ink);
      turnLabel.textContent = o.label;
      turnLabel.classList.toggle("link", !!o.hasLink);
      turnLabel.title = o.hasLink ? "Open this thread in T3 Code" : "";
      ask.textContent = o.ask || (o.canSend ? "You have the tab. Hand it back when you are done, with a note if the agent should do something different." : "You have the tab.");
      // A "Sent" confirmation cut short (the agent acted first) may have hidden these.
      clearTimeout(turnTimer);
      ask.classList.remove("hidden");
      sendForm.classList.toggle("hidden", !o.canSend);
      // Coming back to the card (another page load) keeps what the user already typed.
      if (!turnOn) {
        msg.className = "msg";
        msg.textContent = o.canSend ? "" : "Tell the agent in its chat when you are done.";
        give.disabled = false;
      }
      turnOn = true;
      turn.classList.remove("hidden");
      mount();
    },
    handedBack(text: string) {
      if (!turnOn) return;
      sendForm.classList.add("hidden");
      ask.classList.add("hidden");
      msg.className = "msg";
      msg.textContent = text;
      note.value = "";
      clearTimeout(turnTimer);
      turnTimer = window.setTimeout(() => turnOn && window.__t3BrowserOverlay?.hide(), 2_200);
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
  new MutationObserver(() => (visible || turnOn) && window.__t3BrowserOverlay?.build === BUILD && mount()).observe(document, { childList: true, subtree: false });
})();

export {};
