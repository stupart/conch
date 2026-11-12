import type { CommandOutcome } from "./claude-rotation.ts";
import type { SwapDashboard, SwapUsageAccount } from "./claude-swap.ts";
import {
  claudePromptReady, CLAUDE_LIMIT_STOP, codexGoalLimited, CODEX_GOAL_LIMIT, limitMenuKey, readClaudeLimitMenu,
} from "./claude-limit-menu.ts";

/**
 * Sessions stopped at a usage limit, put back to work (2026-11-12, Tyler: "it didn't autoswitch cause it got stuck on a
 * terminal message", then "resume all").
 *
 * What happened that night: at 00:29 claude-swap's switcher moved Default from account 2, at its limit, to account 1,
 * itself at 90% or more of its week; the one account with room, 3, had a `cswap run` session on it, which the switcher
 * skips without a word (claude-swap.ts `liveRunSessionSlots`). By 00:45 account 1 had run out too: every Default
 * session, and every background agent inside them, stopped on "You've hit your weekly limit", the sessions on Claude
 * Code's menu (claude-limit-menu.ts). The switcher had nowhere to go and said so only to itself. A switch to 3 by hand
 * at 00:53 didn't move them either: a session on that menu waits for a person, so Tyler went round them from his phone.
 *
 * So, while `claude-rotation` and `limit-auto-resume` are on, every `LIMIT_LOOK_MS`:
 *  1. Notice it: a Claude session on Default's login whose transcript ends at a usage limit, waiting on a dialog, and
 *     whose screen shows the menu. Sessions on a login of their own, and Codex's "Goal hit usage limits", are noticed
 *     and told, never touched: switching Default doesn't help them, and Codex's limits are its own.
 *  2. Make sure an account with room is in use: the one in use, by claude-swap's reading, has room; else conch switches
 *     now to the account with the most (`pickRoomyAccount`), through the app's own switch. Never to one at or near its
 *     limit, one it can't read, or one a `cswap run` session is on, as claude-swap's own switcher won't; when that
 *     leaves nowhere, it says why, and a switch made by anyone after is picked up the same way.
 *  3. Resume them, once the sessions have had `SWITCH_SETTLE_MS` to pick the login up: "Stop and wait for limit to
 *     reset", one key per look as background trust prompts are answered (PR #598), then, at an empty prompt with conch's
 *     mic closed and the session not in manual mode, one message to carry on and restart the agents that stopped. Once
 *     per limit event: a session resumed onto an account that stops there again is told, and the account counts as out.
 *  4. Say what it did, once: "Account 1 ran out; switched to account 3 and resumed 4 sessions."
 *
 * Every step is a line in the daemon's log as it happens.
 */

/** At or over this on any of its windows an account is near its limit: never switched to, never counted as having room.
 * claude-swap's own default switching threshold. */
export const NEAR_LIMIT_PCT = 90;
/** How old an account's reading may be and still be believed. An account no session is on doesn't move while unread,
 * and claude-swap reads an idle one every ten minutes. */
export const READING_MAX_AGE_MS = 30 * 60_000;
/** A running session picks a new Default login up when Claude Code's Keychain cache expires, about 30 s on macOS
 * (claude-rotation.ts): resumed sooner, it would ask the account that ran out again. */
export const SWITCH_SETTLE_MS = 45_000;
/** How often conch looks for sessions stopped at a limit. */
export const LIMIT_LOOK_MS = 15_000;
/** A session in a Terminal window is typed into by raising its window. conch does that only once the Mac has been left
 * alone this long, so it never takes the keyboard from under you. */
export const WINDOW_IDLE_SECS = 60;
/** How long a session out of the menu waits for its message (the mic in use, conch speaking) before conch lets it go. */
export const OWED_MESSAGE_MS = 30 * 60_000;
/** conch switches by itself at most this often, so a reading it can't trust never sends it round the accounts. */
export const CONCH_SWITCH_GAP_MS = 10 * 60_000;
/** A notice waits this long at most for sessions still being resumed; the rest go in the next. */
export const NOTICE_HOLD_MS = 5 * 60_000;
/** claude-swap's list (a Python process each time) is read at most this often while sessions are stopped, and less
 * often once it has said no account has room: a week's limit can last days. A switch anyone makes is read at once. */
const DASHBOARD_REUSE_MS = 30_000;
const DASHBOARD_REUSE_NO_ROOM_MS = 2 * 60_000;

export interface LimitSession {
  sessionId: string;
  label: string;
  backend: "claude" | "codex";
  pid?: number;
  /** Claude Code's registry status: the menu is a dialog, "waiting". */
  status?: string;
  /** A Claude session on Default's login, the one rotation switches; false on a profile or a single-session sign-in of
   * its own. Not read for Codex. */
  rotation: boolean;
  /** Its transcript's last outcome was a usage limit (session-usage-limit.ts). */
  usageLimit?: string;
}

/** Why a message can't go into a session now. Manual mode is kept to; the other two pass. */
export type TypeBlocker = "manual mode" | "the mic is open" | "conch is speaking";

export interface LimitNotice {
  text: string;
  /** Something is left for you to do. */
  needsYou: boolean;
  /** conch's own failures in it, each filed as an error. */
  failures: string[];
}

export interface LimitRecoveryDeps {
  enabled(): boolean;
  sessions(): readonly LimitSession[];
  readScreen(session: LimitSession): Promise<string | null>;
  /** In a tmux pane, so keys reach it without its window coming forward. */
  inPane(session: LimitSession): Promise<boolean>;
  idleSeconds(): Promise<number | null>;
  pressKey(session: LimitSession, key: "Up" | "Down" | "Enter"): Promise<boolean>;
  alive(session: LimitSession): boolean;
  dashboard(): Promise<SwapDashboard>;
  liveRunSlots(): ReadonlySet<number>;
  switchTo(slot: number): Promise<CommandOutcome>;
  typeBlocker(session: LimitSession): TypeBlocker | null;
  /** The message, through conch's own delivery: true once it went in, else why not. */
  type(session: LimitSession, text: string): Promise<true | string>;
  notify(notice: LimitNotice): void;
  log(line: string): void;
  now?(): number;
  /** The menu's pace (`answerLimitMenu`), for tests. */
  menu?: AnswerPace;
}

type Room = { room: true; used: number } | { room: false; why: string };

/** Whether an account has room, by claude-swap's reading of it. */
export function accountRoom(account: SwapUsageAccount, now: number, maxAgeMs = READING_MAX_AGE_MS): Room {
  if (account.disabled) return { room: false, why: "held out of the rotation" };
  // "unavailable" is a reading too old for claude-swap to act on, served as its last good one; the rest need a sign-in.
  if (account.status !== "ok" && account.status !== "unavailable") return { room: false, why: "needs signing in again" };
  const read = account.fetchedAt ? Date.parse(account.fetchedAt) : Number.NaN;
  if (!account.windows.length || !Number.isFinite(read)) return { room: false, why: "no usage reading" };
  if (now - read > maxAgeMs) return { room: false, why: `usage last read ${Math.round((now - read) / 60_000)} min ago` };
  const top = account.windows.reduce((most, window) => window.pct > most.pct ? window : most);
  if (top.pct >= NEAR_LIMIT_PCT) return { room: false, why: `${Math.round(top.pct)}% of its ${top.name} limit used` };
  return { room: true, used: top.pct };
}

const LIVE_RUN = "a `cswap run` session is on it";

/** The account to switch to: the most room among the rest, or none, with why each was passed over. */
export function pickRoomyAccount(
  accounts: readonly SwapUsageAccount[],
  active: number,
  liveRun: ReadonlySet<number>,
  now: number,
): { target?: SwapUsageAccount; used?: number; passedOver: string[] } {
  const roomy: Array<{ account: SwapUsageAccount; used: number }> = [];
  const passedOver: string[] = [];
  for (const account of accounts) {
    if (account.number === active) continue;
    const room = accountRoom(account, now);
    if (!room.room) passedOver.push(`account ${account.number}: ${room.why}`);
    else if (liveRun.has(account.number)) passedOver.push(`account ${account.number}: ${LIVE_RUN}`);
    else roomy.push({ account, used: room.used });
  }
  roomy.sort((a, b) => a.used - b.used || a.account.number - b.account.number);
  return roomy[0] ? { target: roomy[0].account, used: roomy[0].used, passedOver } : { passedOver };
}

/** What a session is told once it is out of the menu. Short enough to go in as typed keys, not a paste. */
export function resumeMessage(account: number, conchSwitched: boolean): string {
  return `From conch: your Claude account hit its usage limit, so ${conchSwitched ? "conch switched you to" : "you're now on"} `
    + `account ${account}, which has room. Carry on where you left off, and restart any background agents that stopped on the limit.`;
}

export type LimitMenuOutcome = "answered" | "not shown" | "still asking" | "the session ended";
export interface AnswerPace { waitMs?: number; intervalMs?: number; settleMs?: number }

/**
 * "Stop and wait for limit to reset", chosen one key per look (PR #598's way with the trust prompt): Up or Down while
 * another row is highlighted, Enter only with the stop row highlighted on two looks running, and answered only once
 * the menu has gone. A look that fails is looked at again; only the session being gone ends it early.
 */
export async function answerLimitMenu(
  io: { look(): Promise<string | null>; press(key: "Up" | "Down" | "Enter"): Promise<boolean>; gone(): boolean | Promise<boolean> },
  { waitMs = 20_000, intervalMs = 250, settleMs = 500 }: AnswerPace = {},
): Promise<LimitMenuOutcome> {
  const deadline = Date.now() + waitMs;
  let pressed = false;
  let stopLooks = 0;
  for (;;) {
    let pause = intervalMs;
    const screen = await io.look();
    const menu = screen === null ? null : readClaudeLimitMenu(screen);
    if (screen === null) {
      if (await io.gone()) return "the session ended";
    } else if (menu) {
      stopLooks = menu.highlighted === menu.stop ? stopLooks + 1 : 0;
      const key = limitMenuKey(menu, stopLooks);
      pause = Math.max(intervalMs, settleMs);
      if (key) {
        pressed = true;
        stopLooks = 0;
        // A send that reported failure may still have landed: given longer to show before the screen is believed.
        if (!(await io.press(key))) pause = Math.max(intervalMs, 2_000);
      }
    } else if (pressed) {
      return await io.gone() ? "the session ended" : "answered";
    } else {
      return "not shown";
    }
    if (Date.now() + pause > deadline) {
      if (await io.gone()) return "the session ended";
      return pressed ? "still asking" : "not shown";
    }
    await Bun.sleep(pause);
  }
}

interface Episode {
  startedAt: number;
  ranOut?: number;
  switchedTo?: number;
  on?: number;
  resumed: string[];
  /** Out of the menu, not told to carry on, and why. */
  left: Map<string, string>;
  /** Still on the menu, and why. */
  stuck: Map<string, string>;
  codex: string[];
  noRoom?: string;
  switchFailed?: string;
  failures: string[];
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
const listed = (reasons: ReadonlyMap<string, string>): string => [...reasons].map(([label, why]) => `${label} (${why})`).join(", ");

/** The one notice for what happened: "Account 1 ran out; switched to account 3 and resumed 4 sessions." */
export function limitNoticeText(episode: Omit<Episode, "startedAt" | "failures">): string {
  const ran = episode.ranOut !== undefined ? `Account ${episode.ranOut} ran out` : "Claude's account ran out";
  let lead: string | undefined;
  if (episode.switchedTo !== undefined) lead = `${ran}; switched to account ${episode.switchedTo}`;
  else if (episode.switchFailed) lead = `${ran}; ${episode.switchFailed}`;
  else if (episode.noRoom !== undefined) lead = `${ran} and no other account has room: ${episode.noRoom}`;
  else if (episode.on !== undefined && (episode.resumed.length || episode.left.size)) {
    lead = episode.ranOut !== undefined && episode.ranOut !== episode.on ? `${ran}; Claude is on account ${episode.on} now` : `Claude is on account ${episode.on} now`;
  }
  if (episode.resumed.length) lead = lead ? `${lead} and resumed ${plural(episode.resumed.length, "session")}` : `Resumed ${plural(episode.resumed.length, "session")}`;
  const parts = lead ? [`${lead}.`] : [];
  if (episode.left.size) parts.push(`Out of the limit menu but not told to carry on: ${listed(episode.left)}.`);
  if (episode.stuck.size) parts.push(`Still on the limit menu: ${listed(episode.stuck)}.`);
  if (episode.codex.length) {
    parts.push(`Codex: ${episode.codex.join(", ")} ${episode.codex.length === 1 ? "has" : "have"} hit usage limits (/goal resume); Codex's limits are its own, so conch leaves ${episode.codex.length === 1 ? "it" : "them"} alone.`);
  }
  return parts.join(" ");
}

export class LimitRecovery {
  #looking: Promise<void> | null = null;
  /** The account Default is on, and since when as far as conch knows. */
  #active: { number: number; since: number } | undefined;
  #previous: number | undefined;
  #conchSwitchedAt = Number.NEGATIVE_INFINITY;
  /** The account conch itself last switched to, so the message can say who switched. */
  #conchSwitchedTo: number | undefined;
  /** An account a session conch resumed onto stopped on again, and when: out, until claude-swap reads it afresh. */
  #outOn = new Map<number, number>();
  /** The account each session was last taken out of the menu onto, how that went, and when conch first saw it stopped
   * there again: one limit event, one go. */
  #done = new Map<string, { account: number; outcome: "answered" | "still asking"; againAt?: number }>();
  /** Out of the menu, owed its message. */
  #owed = new Map<string, { account: number; since: number }>();
  /** What a stopped session was last said to be waiting on, so it is said once. */
  #told = new Map<string, string>();
  #codexTold = new Set<string>();
  #codexLookedAt = new Map<string, number>();
  #noRoomTold: string | undefined;
  #dashboardTold: string | undefined;
  #episode: Episode | undefined;
  #dashboard: { at: number; value: SwapDashboard } | undefined;

  constructor(private readonly deps: LimitRecoveryDeps) {}

  /** A switch made elsewhere (claude-swap's switcher, the app's "Use now"): sessions get `SWITCH_SETTLE_MS` to follow. */
  noteSwitch(to: number | undefined, from?: number): void {
    this.#dashboard = undefined;
    this.#noRoomTold = undefined;
    if (to === undefined) return;
    if (this.#active?.number === to) return;
    this.#conchSwitchedTo = undefined;
    this.#previous = from ?? this.#active?.number ?? this.#previous;
    this.#active = { number: to, since: this.#now() };
  }

  /** One look at a time: a look that is still answering menus when the next is due is let finish. */
  look(): Promise<void> {
    this.#looking ??= this.#look()
      .catch((error) => this.deps.log(`usage limit: the look failed: ${error}`))
      .finally(() => { this.#looking = null; });
    return this.#looking;
  }

  #now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  #open(now: number): Episode {
    return this.#episode ??= { startedAt: now, resumed: [], left: new Map(), stuck: new Map(), codex: [], failures: [] };
  }

  /** A stopped session, said once per reason; `waiting` is one conch will get to by itself. */
  #tell(session: LimitSession, why: string, now: number): void {
    if (this.#told.get(session.sessionId) === why) return;
    this.#told.set(session.sessionId, why);
    this.deps.log(`usage limit: "${session.label}" is still on the limit menu: ${why}`);
    this.#open(now).stuck.set(session.label, why);
  }

  async #look(): Promise<void> {
    const deps = this.deps;
    const now = this.#now();
    if (!deps.enabled()) {
      this.#done.clear(); this.#owed.clear(); this.#told.clear(); this.#codexTold.clear(); this.#episode = undefined;
      return;
    }
    const sessions = deps.sessions();
    const live = new Set(sessions.map((session) => session.sessionId));
    for (const ids of [this.#done, this.#owed, this.#told, this.#codexLookedAt]) for (const id of ids.keys()) if (!live.has(id)) ids.delete(id);
    for (const id of this.#codexTold) if (!live.has(id)) this.#codexTold.delete(id);

    // 1. Claude sessions on the menu: the transcript and the registry say where to look; only the screen says it's there.
    const stuck: LimitSession[] = [];
    for (const session of sessions) {
      if (session.backend !== "claude" || !session.pid || session.status !== "waiting" || !session.usageLimit) continue;
      if (this.#owed.has(session.sessionId)) continue;
      const screen = await deps.readScreen(session);
      if (screen !== null && readClaudeLimitMenu(screen)) stuck.push(session);
      else if (screen !== null) this.#told.delete(session.sessionId);
    }
    for (const session of stuck) {
      if (!session.rotation) this.#tell(session, "it's on a sign-in of its own, which rotation doesn't switch", now);
    }
    const ours = stuck.filter((session) => session.rotation);
    await this.#lookAtCodex(sessions, stuck.length > 0, now);
    if (!ours.length && !this.#owed.size) return this.#flush(now, false);

    // 2. An account with room.
    const dashboard = await this.#readDashboard(now);
    const active = dashboard.state === "ready" ? dashboard.accounts.find((account) => account.defaultLogin) : undefined;
    if (!active) {
      const why = dashboard.state !== "ready" ? dashboard.message ?? "claude-swap's list couldn't be read" : "claude-swap doesn't know which account Default is on";
      if (this.#dashboardTold !== why) deps.log(`usage limit: ${plural(ours.length, "session")} stopped, and ${why}`);
      this.#dashboardTold = why;
      return this.#flush(now, false);
    }
    this.#dashboardTold = undefined;
    if (this.#active?.number !== active.number) {
      this.#previous = this.#active?.number ?? this.#previous;
      this.#active = { number: active.number, since: now };
    }
    const episode = this.#open(now);
    for (const session of ours) {
      // Once per stop: stamped on every look, it would outlast every fresh reading claude-swap took after it.
      const done = this.#done.get(session.sessionId);
      if (done?.account !== active.number || done.outcome !== "answered" || done.againAt !== undefined) continue;
      done.againAt = now;
      this.#outOn.set(active.number, Math.max(this.#outOn.get(active.number) ?? 0, now));
    }
    const room = accountRoom(active, now);
    const outAt = this.#outOn.get(active.number);
    const readAt = active.fetchedAt ? Date.parse(active.fetchedAt) : 0;
    const usable = room.room && !(outAt !== undefined && outAt > readAt);
    if (!usable) {
      if (ours.length) {
        episode.ranOut ??= active.number;
        await this.#switchFrom(active.number, room.room ? `a session stopped on it again` : room.why, ours.length, dashboard, now, episode);
      }
      // Switched: the resume is on its way, and in the same notice.
      return this.#flush(now, this.#active.number !== active.number);
    }
    this.#noRoomTold = undefined;
    // 3. Resume, once the sessions have had time to take the login up.
    if (now - this.#active.since < SWITCH_SETTLE_MS) return this.#flush(now, true);
    episode.on = active.number;
    if (this.#previous !== undefined && this.#previous !== active.number) episode.ranOut ??= this.#previous;
    let idle: number | null | undefined;
    const leftAlone = async (session: LimitSession): Promise<boolean> =>
      await deps.inPane(session) || ((idle ??= await deps.idleSeconds()) ?? 0) >= WINDOW_IDLE_SECS;
    let deferred = 0;
    for (const session of ours) {
      const done = this.#done.get(session.sessionId);
      if (done?.account === active.number) {
        this.#tell(session, done.outcome === "answered" ? `it stopped at the limit again on account ${active.number}` : "its menu didn't take conch's keys", now);
        continue;
      }
      if (!(await leftAlone(session))) {
        deferred += 1;
        this.#tell(session, "it's in a Terminal window, which conch raises only once the Mac has been left alone for a minute", now);
        continue;
      }
      const outcome = await answerLimitMenu({
        look: () => deps.readScreen(session),
        press: (key) => deps.pressKey(session, key),
        gone: () => !deps.alive(session),
      }, deps.menu);
      deps.log(`usage limit: "${session.label}": ${outcome === "answered" ? `chose "${CLAUDE_LIMIT_STOP}"` : outcome}`);
      if (outcome === "answered") {
        this.#done.set(session.sessionId, { account: active.number, outcome });
        this.#owed.set(session.sessionId, { account: active.number, since: now });
        this.#told.delete(session.sessionId);
        episode.stuck.delete(session.label);
      } else if (outcome === "still asking") {
        this.#done.set(session.sessionId, { account: active.number, outcome });
        episode.failures.push(`The usage-limit menu in "${session.label}" didn't take conch's keys, so it is still waiting on it: choose "${CLAUDE_LIMIT_STOP}" in its terminal.`);
        this.#tell(session, "its menu didn't take conch's keys", now);
      }
    }

    // The message, once each is free for it.
    const conchSwitched = this.#conchSwitchedTo === active.number;
    for (const [id, owed] of this.#owed) {
      const session = sessions.find((one) => one.sessionId === id);
      if (!session) { this.#owed.delete(id); continue; }
      const leave = (why: string): void => {
        this.#owed.delete(id);
        episode.left.set(session.label, why);
        deps.log(`usage limit: "${session.label}" is out of the menu, not told to carry on: ${why}`);
      };
      if (now - owed.since > OWED_MESSAGE_MS) { leave("conch waited half an hour for it to be free"); continue; }
      const blocker = deps.typeBlocker(session);
      if (blocker === "manual mode") { leave("manual mode"); continue; }
      if (blocker) { deferred += 1; continue; }
      const screen = await deps.readScreen(session);
      const prompt = screen === null ? "not shown" : claudePromptReady(screen);
      if (prompt === "holds words") { leave("something was already typed in its prompt"); continue; }
      if (prompt === "not shown" || !(await leftAlone(session))) { deferred += 1; continue; }
      const typed = await deps.type(session, resumeMessage(active.number, conchSwitched));
      if (typed === true) {
        this.#owed.delete(id);
        episode.resumed.push(session.label);
        deps.log(`usage limit: told "${session.label}" to carry on on account ${active.number}`);
      } else if (typed === "session-awaiting-answer" || typed === "session-awaiting-permission") {
        deferred += 1;
      } else {
        leave(`the message didn't go in: ${typed}`);
        episode.failures.push(`conch couldn't tell "${session.label}" to carry on after the usage limit (${typed}): it is at an empty prompt.`);
      }
    }
    this.#flush(now, deferred > 0 || this.#owed.size > 0);
  }

  async #switchFrom(from: number, why: string, stopped: number, dashboard: SwapDashboard, now: number, episode: Episode): Promise<void> {
    const deps = this.deps;
    if (now - this.#conchSwitchedAt < CONCH_SWITCH_GAP_MS) return;
    const pick = pickRoomyAccount(dashboard.accounts, from, deps.liveRunSlots(), now);
    if (!pick.target) {
      const passed = pick.passedOver.length ? pick.passedOver.join("; ") : "there's no other account in the rotation";
      if (this.#noRoomTold === passed) return;
      this.#noRoomTold = passed;
      deps.log(`usage limit: account ${from} is out (${why}) with ${plural(stopped, "session")} stopped on it, and no account has room: ${passed}`);
      episode.noRoom = pick.passedOver.some((reason) => reason.endsWith(LIVE_RUN))
        ? `${passed}. To use that one anyway, choose it in Settings › Providers › Claude: conch resumes the stopped sessions once you do`
        : passed;
      return;
    }
    const to = pick.target.number;
    deps.log(`usage limit: account ${from} is out (${why}) with ${plural(stopped, "session")} stopped on it; switching Claude to account ${to} (${Math.round(pick.used ?? 0)}% used)`);
    this.#conchSwitchedAt = now;
    const outcome = await deps.switchTo(to);
    if (!outcome.ok) {
      deps.log(`usage limit: switching to account ${to} failed: ${outcome.output.slice(-200)}`);
      episode.switchFailed = `couldn't switch to account ${to}`;
      episode.failures.push(`conch couldn't switch Claude to account ${to} after account ${from} ran out: ${outcome.output.slice(-200)}`);
      return;
    }
    episode.switchedTo = to;
    this.noteSwitch(to, from);
    this.#conchSwitchedTo = to;
  }

  async #lookAtCodex(sessions: readonly LimitSession[], claudeStopped: boolean, now: number): Promise<void> {
    for (const session of sessions) {
      if (session.backend !== "codex" || !session.pid || (!session.usageLimit && !claudeStopped)) continue;
      if (now - (this.#codexLookedAt.get(session.sessionId) ?? Number.NEGATIVE_INFINITY) < 60_000) continue;
      this.#codexLookedAt.set(session.sessionId, now);
      const screen = await this.deps.readScreen(session);
      if (screen === null) continue;
      if (!codexGoalLimited(screen)) { this.#codexTold.delete(session.sessionId); continue; }
      if (this.#codexTold.has(session.sessionId)) continue;
      this.#codexTold.add(session.sessionId);
      this.deps.log(`usage limit: Codex session "${session.label}" shows "${CODEX_GOAL_LIMIT}"; Codex's limits are its own, so conch leaves it`);
      this.#open(now).codex.push(session.label);
    }
  }

  async #readDashboard(now: number): Promise<SwapDashboard> {
    const reuse = this.#noRoomTold === undefined ? DASHBOARD_REUSE_MS : DASHBOARD_REUSE_NO_ROOM_MS;
    if (this.#dashboard && now - this.#dashboard.at < reuse) return this.#dashboard.value;
    const value = await this.deps.dashboard();
    this.#dashboard = { at: now, value };
    return value;
  }

  /** The notice, once nothing more is coming by itself, or it has waited long enough. */
  #flush(now: number, inFlight: boolean): void {
    const episode = this.#episode;
    if (!episode) return;
    const said = episode.switchedTo !== undefined || episode.switchFailed !== undefined || episode.noRoom !== undefined
      || episode.resumed.length > 0 || episode.left.size > 0 || episode.stuck.size > 0 || episode.codex.length > 0;
    if (!said) {
      if (!inFlight) this.#episode = undefined;
      return;
    }
    if (inFlight && now - episode.startedAt < NOTICE_HOLD_MS) return;
    this.#episode = undefined;
    const text = limitNoticeText(episode);
    const needsYou = episode.noRoom !== undefined || episode.switchFailed !== undefined || episode.left.size > 0
      || episode.stuck.size > 0 || episode.codex.length > 0;
    this.deps.notify({ text, needsYou, failures: episode.failures });
  }
}
