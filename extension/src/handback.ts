// Hand back: the user had one of the agent's tabs (pressed Esc, or the agent asked for a step
// only they can do) and gives it back from the page, optionally with a note. The note reaches
// the agent as a new message in its T3 Code thread, posted as the user.

/** Longest note the page accepts. */
export const NOTE_MAX = 2_000;

/** A URL without query or fragment: after a login those often carry codes or tokens. */
function where(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.origin + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url.split(/[?#]/)[0];
  }
}

/** The message posted to the thread. Names the tab, so the agent can carry on in it. */
export function handbackMessage(tabId: number, title: string | undefined, url: string | undefined, note: string): string {
  const page = [title?.trim() ? `“${title.trim()}”` : "", where(url)].filter(Boolean).join(" at ");
  const head = `[T3 Browser] Handing tab ${tabId}${page ? ` (${page})` : ""} back to you.`;
  const text = note.trim().slice(0, NOTE_MAX);
  return text ? `${head}\n\n${text}` : `${head} Carry on where you left off.`;
}
