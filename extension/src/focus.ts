// When a page an agent works in opens a popup or a target=_blank tab, Chrome brings the new tab
// to the front. Agents work in the background, so the user's tab goes back in front, but only
// for that one activation that came with opening it. Pure, so it is unit tested.

export interface NewTabActivation {
  /** The tab that just came to the front. */
  tabId: number;
  /** The tab that opened it (an agent's tab, or not). */
  source: number;
  sourceIsAgentTab: boolean;
  /** How long ago the new tab was created. */
  ageMs: number;
  /** The tab that was in front before. */
  before: number | undefined;
  /** The extension itself brought it forward (to screenshot it). */
  ownActivation: boolean;
  /** This new tab was already judged once. */
  alreadyDecided: boolean;
}

/** The tab to put back in front, or undefined to leave things as they are. */
export function tabToRestore(a: NewTabActivation): number | undefined {
  if (a.ownActivation || a.alreadyDecided || !a.sourceIsAgentTab) return undefined;
  // Later activations (the user clicks the new tab, ...) are somebody's choice.
  if (a.ageMs > 1_000) return undefined;
  // The agent's tab was in front: the user is watching it, and a popup there is expected.
  if (a.before === undefined || a.before === a.source || a.before === a.tabId) return undefined;
  return a.before;
}

/**
 * The tab that was in front before a new tab: the current one, unless the new tab already is
 * the current one (activation reported first), then the one before that.
 */
export function tabBefore(newTab: number, current: number | undefined, previous: number | undefined): number | undefined {
  return current === newTab ? previous : current;
}
