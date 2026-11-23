#!/usr/bin/env node
/**
 * sumibako - file what your coding agent wrote into your vault.
 *
 * Zero dependencies, one file, Node 18 or newer. That is a deliberate ceiling:
 * this runs inside somebody else's agent session, often on a machine where the
 * install has to be instant and silent, and a dependency tree is a thing that
 * can break there in ways nobody will debug.
 *
 * Why a CLI at all, when the same job could be an MCP server. Two reasons that
 * matter in practice. An MCP tool call carries the document through the model's
 * context to get it to the server, so filing a 30KB plan means re-emitting
 * 30KB of tokens; `sumibako publish plan.md` sends a file the agent has already
 * written to disk, and the model never sees it twice. And a shell exists in
 * every coding agent there is, while MCP support differs between them and
 * changes with the spec. An MCP server can come later and reuse this same API.
 */

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The version, read from `package.json` rather than written twice.
 *
 * It was a literal here until `npm version patch` bumped the manifest and left
 * this behind, so a freshly published 0.2.1 introduced itself as 0.2.0. That is
 * a small lie with an outsized cost: the first thing anybody does with a bug
 * report is ask which version, and the answer was wrong.
 *
 * Read lazily, so the only command that needs the file is the one that pays for
 * it, and forgiving of a missing file: a version string is not worth failing a
 * publish over.
 */
function version() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(
      fs.readFileSync(path.join(here, "package.json"), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
}

/**
 * Exit code for "this machine is not connected yet".
 *
 * Distinct from 1 so that the thing reading this output can tell a missing
 * credential from a failed command. That distinction is the whole reason the
 * connect flow works from inside an agent session: the skill tells the agent
 * that 3 means "show the user the link and run the same command again", and
 * every other non-zero code means the command genuinely failed.
 */
const EXIT_NEEDS_AUTH = 3;

/** Where the token lives when it is not in the environment. */
const CONFIG_DIR = path.join(os.homedir(), ".sumibako");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/**
 * Where the API lives.
 *
 * The app's own domain rather than the Convex deployment behind it. This string
 * ends up in config files, CI secrets and other people's shell history, so it
 * has to be one that stays true - `next.config.mjs` rewrites it onto whichever
 * deployment is current.
 */
const DEFAULT_API = "https://sumibako.com/api/agent";

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
/**
 * ANSI colour, with the escape byte written as an escape rather than typed.
 *
 * A literal escape character in source is invisible in every diff and every
 * review, and survives exactly until something normalises the file.
 */
const ESC = "\u001b";
const paint = (code, text) =>
  useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text;
const dim = (text) => paint("2", text);
const bold = (text) => paint("1", text);
const green = (text) => paint("32", text);
const red = (text) => paint("31", text);
const yellow = (text) => paint("33", text);

function die(message, hint) {
  console.error(`${red("error")}  ${message}`);
  if (hint) console.error(dim(`        ${hint}`));
  process.exit(1);
}

/**
 * Stops with the "connect this machine" instructions, and exit code 3.
 *
 * Written to stdout rather than stderr, unlike every other failure here. This
 * is not an error report: it is a link somebody has to open, and the caller is
 * as often an agent relaying it into a chat window as a person reading a
 * terminal. Errors go to stderr because they are diagnostics; this is content.
 */
function needsAuth(url, code) {
  console.log(`${bold("Connect this machine to Sumibako:")}`);
  console.log(url);
  console.log();
  console.log(dim(`It should show the code ${bold(code)}. If it does not, the`));
  console.log(dim("page belongs to a different request - close it."));
  console.log();
  console.log(dim("Then run the same command again."));
  process.exit(EXIT_NEEDS_AUTH);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", {
    // The file holds a live credential. 0600 is the difference between "only
    // me" and "every process running as any user on this machine", and it
    // costs one argument. Windows ignores the mode, which is why the token is
    // also accepted from the environment.
    mode: 0o600,
  });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Best effort: some filesystems do not support it.
  }
}

/**
 * The token, from the environment first and the config file second.
 *
 * Environment first so CI can inject one without writing to a home directory
 * that may not persist, and so a person can override a stale saved token for
 * one command without editing a file.
 */
function resolveToken() {
  const fromEnv = process.env.SUMIBAKO_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readConfig().token ?? null;
}

function resolveApi() {
  return (
    process.env.SUMIBAKO_API?.trim().replace(/\/+$/, "") ||
    readConfig().api ||
    DEFAULT_API
  );
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One request, with the two failures that are about the address rather than
 * the call: an unreachable host, and a server that answered but not as this
 * API. Everything else is handed back for the caller to interpret.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_TIMEOUT_MS = 12_000;

async function rawCall(
  method,
  base,
  endpoint,
  { body, query, token, tolerateNetworkError = false, retry = false } = {},
) {
  const url = new URL(base + endpoint);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  /*
    A call that is safe to say twice is given a clock and three tries.

    The web front door in front of this API sometimes accepts a connection and
    then says nothing for ten to twenty seconds before resetting it (measured
    2026-10-25: about one request in twenty-five, static files included, while
    the backend itself never stalled). A fresh connection a moment later answers
    at once, so waiting out the stall is the wrong move and trying again is the
    right one. Only a call that is idempotent asks for this: a read, a page
    filed under its key, a file recorded by its hash. `append` and `edit` do
    not, because a request that was delivered and whose answer was lost would be
    applied twice, so they keep one try and no clock.
  */
  const attempts = retry ? RETRY_ATTEMPTS : 1;
  let response;
  let failure = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // The clock covers the wait for an answer to start and is put away once
    // one has, so reading a long reply is never cut short.
    const stop = retry ? new AbortController() : null;
    const timer = stop ? setTimeout(() => stop.abort(), RETRY_TIMEOUT_MS) : null;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          // Which agent is running this, for the badge on the page it writes
          // and the vault's usage counts. Nothing when none can be told.
          ...(runningAgent ? { "Sumibako-Agent": runningAgent } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: stop?.signal,
      });
      failure = null;
      break;
    } catch (error) {
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (failure) {
    const error = failure;
    /*
      A dropped connection, not a refusal.

      Fatal for a single command, because retrying is not ours to decide:
      `append` and `edit` are not idempotent, and a `fetch` that rejects may
      still have been delivered - the response is what went missing. Quietly
      sending it again could add the same paragraph twice.

      A poll is the exception, and says so by passing the flag. It repeats the
      same question until it gets an answer or runs out of time, so one lost
      reply should cost a couple of seconds rather than the whole command.
    */
    if (tolerateNetworkError) return null;
    die(
      `Could not reach ${url.origin}.`,
      "Check your connection and run the same command again.",
    );
  }

  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  let payload = null;
  if (text && contentType.includes("json")) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Handled below, along with every other not-our-API response.
    }
  }

  /*
    Reached a server, but not this API.

    Overwhelmingly this means the base URL points at the web app rather than the
    API, and the app answered with an HTML page. Printing that page is how a
    one-line configuration mistake turns into a screenful of markup with the
    actual problem nowhere in it, so the body is deliberately not shown.
  */
  if (payload === null) {
    die(
      `${base} is not answering as the Sumibako API (HTTP ${response.status}, ${contentType || "no content type"}).`,
      "Check the address: pass --api <url>, or set SUMIBAKO_API.",
    );
  }

  return { response, payload, text };
}

async function callApi(method, endpoint, { body, token, query, api, retry } = {}) {
  const base = api ?? resolveApi();

  /*
    A token, or the connect flow, before anything is sent.

    `ensureToken` can exit the process here, which is deliberate: every caller
    of this function needs a credential, and there is nothing sensible for one
    of them to do with "there isn't one" that is not already done better in one
    place.
  */
  const authToken = token ?? (await ensureToken(base));

  const { response, payload, text } = await rawCall(method, base, endpoint, {
    body,
    query,
    token: authToken,
    retry,
  });

  if (!response.ok) {
    const message = payload?.error?.message ?? text.slice(0, 300) ?? "Request failed.";
    const code = payload?.error?.code;

    // The three failures worth explaining rather than just reporting, because
    // each has a next step the person cannot guess from the message alone.
    if (response.status === 401) {
      /*
        A saved token that the server refuses is a revoked one, and keeping it
        would wedge this machine: every future command would authenticate with
        it, fail, and print the same advice. Dropping it means the next command
        starts a connect flow instead, which is the thing the person was going
        to have to do anyway.

        Only when it came from the config file. A token in the environment is
        not ours to forget, and pretending to have forgotten it would send
        somebody looking in the wrong place.
      */
      if (process.env.SUMIBAKO_TOKEN?.trim()) {
        // Running it again would fail identically, forever: the environment
        // wins over the config file, so there is nothing for a connect flow
        // to take effect on until that variable is dealt with.
        die(
          message,
          "SUMIBAKO_TOKEN is set. Unset it and run the same command again to connect this machine.",
        );
      }
      const config = readConfig();
      if (config.token) {
        delete config.token;
        writeConfig(config);
      }
      die(message, "Run the same command again to connect this machine.");
    }
    if (response.status === 403) {
      // Two refusals share this status and only one is about the token. A
      // missing permission names itself in the message; anything else, such
      // as an account whose email is not verified, says what to do in its own
      // words, and advice about tokens beside it would send somebody to fix
      // the wrong thing.
      die(
        message,
        /permission/i.test(message)
          ? "Create a token with that permission, in Settings, under Coding agents."
          : undefined,
      );
    }
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      die(message, retry ? `Wait ${retry} seconds and try again.` : undefined);
    }
    die(`${message}${code ? dim(`  (${code})`) : ""}`);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Connecting a machine
// ---------------------------------------------------------------------------

/*
  Getting a token without anybody typing one.

  The old flow was: open the app, mint a token, copy it, paste it here. That
  reads as four steps and is really one problem - the paste can only be done by
  a person sitting at this terminal, so connecting had to happen before the
  agent was any use, and an agent that hit a missing token could do nothing but
  give up and explain.

  This is the device authorization grant. We hold 32 random bytes, send their
  hash, get a short code back, and the approval happens in a browser where the
  person already has a session. The bytes are what redeems the request, so the
  code travelling through a URL and a scrollback gives nothing away.

  Two properties are load-bearing for the agent case. Nothing here reads stdin,
  so it works with no terminal attached. And nothing blocks for long: the first
  run prints a link and exits, and a later run collects the token, so an agent
  relays one line to its user and carries on instead of sitting inside a
  command until the harness kills it.

  On the person's own desktop the first run opens the page itself and waits
  half a minute before printing the link, because somebody already signed in
  approves in a few seconds, and then the command simply finishes its job: no
  link to copy out of a chat, no second run. Half a minute is short enough to
  sit inside an agent's command timeout, and after it everything is as above.
*/

/** How long a redeem waits before giving the link back to the caller. */
const REDEEM_WAIT_MS = 20_000;

/** How long the first run waits after opening the approval page itself. */
const OPENED_WAIT_MS = 30_000;

/** Gap between redeem attempts while waiting. */
const REDEEM_INTERVAL_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a browser opened from here would appear in front of the person.
 *
 * Not "is stdout a terminal": an agent running on the person's own computer
 * has no terminal either, and that is exactly where opening the page saves
 * them copying a link out of a chat. What rules it out is a browser that would
 * open for nobody - over SSH, in CI, on Linux with no display, which covers
 * containers and cloud sandboxes - or `SUMIBAKO_NO_BROWSER` being set.
 */
function mayOpenBrowser() {
  const env = process.env;
  if (env.SUMIBAKO_NO_BROWSER || env.CI) return false;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (process.platform === "win32" || process.platform === "darwin") {
    return true;
  }
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Opens a URL in the desktop browser, and does not care if it cannot.
 *
 * Resolves whether the opener started, which is all that can be known: nothing
 * reports back whether a tab appeared. The link is printed either way.
 */
function openInBrowser(url) {
  return new Promise((resolve) => {
    try {
      const [command, args] =
        process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];
      const child = spawn(command, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/** Describes this machine for the approval page. Never a secret. */
function describeClient() {
  return `${os.hostname()}, ${process.platform}`;
}

/**
 * Opens a connection request and remembers the half of it we must keep.
 *
 * The verifier is stored next to where the token will go, under the same 0600,
 * because between this call and the next command it is the thing that can
 * collect a credential.
 */
async function startConnect(base) {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const verifierHash = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("hex");

  const { response, payload } = await rawCall("POST", base, "/v1/cli/start", {
    body: { verifierHash, client: describeClient() },
  });

  if (!response.ok) {
    die(
      payload?.error?.message ?? "Could not start the connection.",
      "Check the address: pass --api <url>, or set SUMIBAKO_API.",
    );
  }

  const pending = {
    userCode: payload.userCode,
    verifier,
    verificationUrl: payload.verificationUrl,
    expiresAt: payload.expiresAt,
    api: base,
  };
  writeConfig({ ...readConfig(), pending });
  return pending;
}

/** The pending request, if there is one and it is still worth trying. */
function readPending(base) {
  const pending = readConfig().pending;
  if (!pending?.verifier || !pending?.userCode) return null;
  if (typeof pending.expiresAt === "number" && pending.expiresAt < Date.now()) {
    return null;
  }
  // A request opened against one deployment cannot be redeemed at another.
  if (pending.api && pending.api !== base) return null;
  return pending;
}

function clearPending() {
  const config = readConfig();
  delete config.pending;
  writeConfig(config);
}

/**
 * Waits for approval, up to `waitMs`, and saves the token when it arrives.
 *
 * Returns the token, or null if it is still pending. Anything that ends the
 * request - denied, expired, collected already - clears the saved request and
 * returns null, so the caller starts a fresh one rather than retrying a dead
 * code forever.
 */
async function redeemPending(base, pending, waitMs) {
  const deadline = Date.now() + waitMs;

  for (;;) {
    const attempt = await rawCall("POST", base, "/v1/cli/redeem", {
      body: { userCode: pending.userCode, verifier: pending.verifier },
      tolerateNetworkError: true,
    });

    /*
      The connection dropped. Wait and ask again rather than giving up.

      Almost every poll answers "pending" and consumes nothing, so repeating
      one is free. The exception is the single reply that carries the token: if
      that is the one that goes missing, the code has been spent and asking
      again gets `expired`. The cost of that is one more `login`, which is why
      this is a retry rather than something more careful.
    */
    if (attempt === null) {
      if (Date.now() + REDEEM_INTERVAL_MS > deadline) return null;
      await sleep(REDEEM_INTERVAL_MS);
      continue;
    }

    const { response, payload } = attempt;

    /*
      A 409 is the account refusing the token, not the request dying.

      It is what comes back when somebody approved and the account already
      holds its maximum of live tokens. The request is still approved and still
      collectable, so the saved half of it is kept: once a token has been
      revoked in Settings, the same command picks up where this left off.

      Treating it like every other failure - forget the request, open a new
      one - was a loop with no exit. The person approved, the mint was refused,
      a new link was printed, they approved that, and at no point did anything
      show them the sentence that says why.
    */
    if (response.status === 409) {
      die(
        payload?.error?.message ?? "The account refused a new token.",
        "Revoke one in Settings, under Coding agents, then run the same command again.",
      );
    }

    if (!response.ok) {
      clearPending();
      return null;
    }

    if (payload.status === "approved") {
      const config = readConfig();
      delete config.pending;
      writeConfig({ ...config, token: payload.token });
      return payload;
    }

    if (payload.status !== "pending") {
      // Denied or expired. Either way this code is finished.
      clearPending();
      return null;
    }

    if (Date.now() + REDEEM_INTERVAL_MS > deadline) return null;
    await sleep(REDEEM_INTERVAL_MS);
  }
}

/**
 * A usable token, or the connect instructions and exit 3.
 *
 * The whole flow in one function, because every authenticated command needs
 * exactly this and none of them should be deciding any part of it themselves.
 */
async function ensureToken(base) {
  const saved = resolveToken();
  if (saved) return saved;

  const pending = readPending(base);
  if (pending) {
    const approved = await redeemPending(base, pending, REDEEM_WAIT_MS);
    if (approved) return approved.token;

    // Still waiting: hand the same link back rather than opening a second
    // request, so the page the person already has open is the right one.
    const current = readPending(base);
    if (current) needsAuth(current.verificationUrl, current.userCode);
  }

  const started = await startConnect(base);

  if (mayOpenBrowser() && (await openInBrowser(started.verificationUrl))) {
    console.log(`Opened ${started.verificationUrl} to connect this machine.`);
    console.log(
      dim(
        `Approve it there (code ${bold(started.userCode)}). Waiting up to ${OPENED_WAIT_MS / 1000} seconds...`,
      ),
    );
    const approved = await redeemPending(base, started, OPENED_WAIT_MS);
    if (approved) {
      console.log(`${green("Connected.")} Carrying on.`);
      console.log();
      return approved.token;
    }
    // Not yet: the tab that opened is the right page, so its link goes back.
    const current = readPending(base);
    if (current) needsAuth(current.verificationUrl, current.userCode);
    // Denied or expired while waiting, which ended that request.
    const fresh = await startConnect(base);
    needsAuth(fresh.verificationUrl, fresh.userCode);
  }

  needsAuth(started.verificationUrl, started.userCode);
}

// ---------------------------------------------------------------------------
// Which agent is running this
// ---------------------------------------------------------------------------

/**
 * The coding agent running this command, as a name the server knows, or
 * undefined when nothing says.
 *
 * Sent with every request so the page shows a badge for the agent that wrote
 * it (inside the owner's vault only, never on a published page). The server
 * turns the name into one of its own ids and calls anything it does not know
 * "Other agent", so a name here only has to be recognisable, not exact.
 *
 * In order, first answer wins:
 *   --agent <name>      what the agent says it is; the skill asks for it
 *   SUMIBAKO_AGENT      the same, for a wrapper or a CI job
 *   AI_AGENT            the cross-vendor variable (agents.md issue #136);
 *                       Claude Code sets claude-code_<version>_agent, and
 *                       0, false, no or off mean "not an agent"
 *   CLAUDECODE=1        Claude Code
 *   CODEX_CI, CODEX_THREAD_ID, CODEX_SESSION_ID   Codex (its exec env)
 *   CURSOR_AGENT        Cursor's agent terminal and cursor-agent
 *   GEMINI_CLI          Gemini CLI
 *   COPILOT_AGENT, COPILOT_CLI   GitHub Copilot
 *   GITHUB_ACTIONS=true a workflow with no agent in it
 *
 * Collected on 2026-11-22 from each tool's own source or documentation.
 * Cursor's editor also sets CURSOR_TRACE_ID in a terminal a person types
 * into, which is why that one is not read: a person is not an agent.
 */
function detectAgent(env, flag) {
  const said = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (said(flag)) return said(flag);
  if (said(env.SUMIBAKO_AGENT)) return said(env.SUMIBAKO_AGENT);
  const aiAgent = said(env.AI_AGENT);
  if (aiAgent && !/^(0|false|no|off)$/i.test(aiAgent)) return aiAgent;
  if (env.CLAUDECODE === "1") return "claude-code";
  if (env.CODEX_CI || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID) return "codex";
  if (said(env.CURSOR_AGENT)) return "cursor";
  if (said(env.GEMINI_CLI)) return "gemini";
  if (said(env.COPILOT_AGENT) || said(env.COPILOT_CLI)) return "copilot";
  if (env.GITHUB_ACTIONS === "true") return "github-actions";
  return undefined;
}

/** Set once in `main`, read by every request. */
let runningAgent;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Flags that never take a value.
 *
 * Without this list `--passcode plan.md` read the file name as the flag's
 * value and then asked "Which file?", because nothing distinguishes a switch
 * from an option that happens to be followed by a word. An agent puts flags
 * wherever it likes, so these never swallow the argument after them.
 */
const SWITCHES = new Set([
  "yes",
  "undo",
  "dry-run",
  "public",
  "publish",
  "passcode",
  "anyone",
  "new-passcode",
  "new",
  "prepend",
  "markdown",
  "text",
  "help",
]);

/** Parses `--flag value`, `--flag=value` and `--boolean` into an object. */
function parseFlags(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const equals = item.indexOf("=");
    if (equals !== -1) {
      flags[item.slice(2, equals)] = item.slice(equals + 1);
      continue;
    }
    const name = item.slice(2);
    const next = argv[index + 1];
    if (SWITCHES.has(name) || next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }

  return { flags, positional };
}

/**
 * The banners a page's cover can be, for the help text.
 *
 * Not a check. The server holds the real list and refuses a name it does not
 * know, with the names in the message, so a banner added there works from a
 * copy of this file that has never heard of it. This is here so `help` can
 * say what to type, and the repository this ships from holds it against the
 * server's list.
 */
const COVERS = [
  "brush",
  "blue-hour",
  "contours",
  "flow",
  "mist",
  "sundown",
  "garden",
  "stars",
  "enso",
  "ridges",
  "doodles",
  "doodles-night",
  "boxes",
  "stitch",
  "dawn",
  "dusk",
  "waves",
  "blueprint",
  "ripples",
  "code",
  "halftone",
  "aurora",
  "maze",
  "circuit",
  "weave",
  "eclipse",
  "bloom",
  "fireflies",
];

/**
 * What --cover was given. --banner is read too: it is what the files are
 * called, and a flag this parser has never heard of is dropped without a
 * word, so the page would be filed with a different banner and no reason.
 */
const coverFlag = (flags) =>
  typeof flags.cover === "string"
    ? flags.cover
    : typeof flags.banner === "string"
      ? flags.banner
      : undefined;

/**
 * The key a file is filed under, so re-running lands on one page.
 *
 * The repo-relative path, because that is the identity of an artifact that a
 * person and an agent will both agree on: `docs/plans/auth.md` is the plan for
 * auth, this week and next. Falls back to the path as given when the file sits
 * outside a git repository.
 *
 * Normalised to forward slashes so the same file keyed from Windows and from
 * CI resolves to the same page.
 */
function defaultKey(filePath) {
  const absolute = path.resolve(filePath);
  const root = gitRoot(path.dirname(absolute));
  return (root ? path.relative(root, absolute) : absolute)
    .split(path.sep)
    .join("/");
}

/** The repository a directory is in, or null when it is in none. */
function gitRoot(start) {
  let directory = start;
  for (let depth = 0; depth < 40; depth += 1) {
    if (fs.existsSync(path.join(directory, ".git"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * The project a file belongs to: its repository's `owner/name`, or the
 * repository's folder name when it has no remote. Null outside a repository.
 *
 * Sent with every write and every lookup by key, because a key is a path
 * inside a repository and two repositories both have a `docs/plan.md`: the
 * server keeps one page per path per project, and files each project's pages
 * in a folder of their own. The remote rather than the folder, because the
 * same repository is cloned into differently named folders, worktrees among
 * them, and is still the same project.
 */
function projectOf(filePath) {
  const root = gitRoot(path.resolve(filePath));
  if (!root) return null;
  let remote = "";
  try {
    remote = execFileSync("git", ["-C", root, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    // No remote, or no git on the PATH. The folder still names the project.
  }
  return projectFromRemote(remote) ?? path.basename(root);
}

/**
 * `owner/name` out of a remote's address, or null when there is none to read.
 *
 * Every form git takes: `https://github.com/acme/app.git`,
 * `git@github.com:acme/app.git`, `ssh://git@host:22/acme/app`, and a GitLab
 * subgroup or an Azure `_git` path, where the last two segments that name
 * something are the ones a person would call it by.
 */
function projectFromRemote(remote) {
  const address = (remote ?? "").trim();
  if (!address) return null;
  const pathPart = address
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i, "")
    .replace(/^[^@/]+@[^:/]+:/, "")
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "");
  const segments = pathPart
    .split(/[\\/]/)
    .filter((segment) => segment && segment !== "_git" && segment !== "~");
  if (segments.length === 0) return null;
  return segments.slice(-2).join("/");
}

/** The project a command's target is in: the flag, else the file's repository. */
function projectFor(flags, filePath) {
  if (typeof flags.project === "string" && flags.project.trim()) {
    return flags.project.trim();
  }
  return projectOf(filePath) ?? undefined;
}

function readMarkdown(filePath) {
  if (filePath === "-") {
    return fs.readFileSync(0, "utf8");
  }
  if (!fs.existsSync(filePath)) {
    die(`No such file: ${filePath}`);
  }
  const stats = fs.statSync(filePath);
  if (stats.isDirectory()) {
    die(`${filePath} is a directory. Point at one Markdown file.`);
  }
  return fs.readFileSync(filePath, "utf8");
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/*
  Putting a picture, a recording or a document on a page.

  Two ways in. An embed in the Markdown this command is about to send -
  `![](./shot.png)` on a line - is uploaded and re-pointed at the stored copy,
  because sent as written it is a broken image on the page. And `attach` adds
  files named on the command line to a page that already exists.

  The bytes do not go through the API. It says where to send each file, the
  file goes straight to storage, and the API is told it arrived; that is what
  lets a 100MB upload work at all. Every file is sent with its SHA-256 first,
  and one the account already holds is not sent again, so publishing a plan
  five times uploads its screenshots once.

  Which block a file becomes is not decided here. The API answers with the
  kind and the Markdown line for it, so this file holds no table of types to
  drift out of step with the server's.
*/

/**
 * What an embed in a Markdown file may take off the disk by itself.
 *
 * Narrow on purpose, and the one list of file types this file keeps. An embed
 * is acted on without anybody naming the file on the command line, and the
 * Markdown may be somebody else's: a document that embedded
 * `../../customers.csv` would otherwise have this command upload it, and
 * `--public` put it on the web. So an embed uploads the things a page shows -
 * pictures, video, audio, a PDF - and anything else takes `attach`, where a
 * person or their agent names the file deliberately.
 */
const EMBED_UPLOADS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "heic", "heif",
  "mp4", "m4v", "webm", "mov",
  "mp3", "wav", "ogg", "m4a", "aac", "flac",
  "pdf",
]);

/** Most files named in one request, which is the API's own ceiling. */
const FILES_PER_REQUEST = 20;

/** `![alt](destination "title")`, with the destination bare or in `<>`. */
const EMBED =
  /!\[((?:\\.|[^\]\\])*)\]\(\s*(?:<([^<>\n]*)>|([^\s()<>]+))(?:\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?\s*\)/;

/** A byte count as a person would say it. */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Every embed in a piece of Markdown, with where it sits in the text.
 *
 * Not a Markdown parser, and it errs one way on purpose: anything it is unsure
 * of is left exactly as written. What it must never do is reach into code. A
 * fenced block or a code span that shows `![](./shot.png)` is an example of
 * the syntax, and rewriting it would change somebody's documentation and
 * upload a file nobody asked for.
 */
function findEmbeds(markdown) {
  const found = [];
  let fence = null;
  let offset = 0;

  for (const line of markdown.split("\n")) {
    const marker = /^[\s>]*(`{3,}|~{3,})/.exec(line);
    const rest = marker ? line.slice(marker[0].length) : "";

    if (fence) {
      // Closed by a run of the same character at least as long, alone.
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !rest.trim()
      ) {
        fence = null;
      }
    } else if (marker && !(marker[1][0] === "`" && rest.includes("`"))) {
      // A backtick fence cannot have a backtick after it on its line; with
      // one, this is a code span that happens to start the line.
      fence = marker[1];
    } else {
      // Code spans are blanked to the same length, so what is found in the
      // blanked line sits at the same place in the real one.
      const visible = line.replace(
        /(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g,
        (span) => " ".repeat(span.length),
      );
      for (const hit of visible.matchAll(new RegExp(EMBED, "g"))) {
        const written = line.slice(hit.index, hit.index + hit[0].length);
        const embed = EMBED.exec(written);
        if (!embed || embed.index !== 0 || embed[0].length !== written.length) {
          continue;
        }
        found.push({
          start: offset + hit.index,
          end: offset + hit.index + written.length,
          alt: embed[1],
          destination: embed[2] ?? embed[3],
          // As written, quotes included, so it can go back unchanged.
          title: embed[4] ?? "",
        });
      }
    }
    offset += line.length + 1;
  }

  return found;
}

/** True when `file` is inside `directory`, and not the directory itself. */
function isInside(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * Decides what an embed's destination is: an address, a file to upload, or a
 * file to leave alone and say why.
 *
 * Returns null for an address, which is none of this command's business.
 * Otherwise `{ file }` for one to upload, or `{ note }` for one that stays as
 * written.
 *
 * Two fences, both from the reasoning on `EMBED_UPLOADS`. The type has to be
 * one a page shows. And the file has to be inside the repository the Markdown
 * is in, or inside the Markdown's own folder when it is in no repository, so
 * that an embed cannot walk up out of the project to something else on the
 * machine. The check is made on the real path, after links are followed,
 * because a link inside the repository can point anywhere.
 */
function locateEmbed(destination, baseDir) {
  const written = destination.trim();
  if (!written) return null;
  // A scheme of two letters or more. One letter is a Windows drive.
  if (/^[a-z][a-z0-9+.-]+:/i.test(written)) return null;
  if (/^(\/\/|#|\?)/.test(written)) return null;

  // As written first, then with `%20` and the like decoded, because both are
  // how a path with a space in it gets into Markdown.
  const candidates = [written];
  try {
    const decoded = decodeURIComponent(written);
    if (decoded !== written) candidates.push(decoded);
  } catch {
    // Not percent-encoding after all.
  }

  let file = null;
  for (const candidate of candidates) {
    const absolute = path.resolve(baseDir, candidate);
    try {
      if (fs.statSync(absolute).isFile()) {
        file = fs.realpathSync(absolute);
        break;
      }
    } catch {
      // Not there under this spelling.
    }
  }
  if (!file) {
    return {
      note: `No file at ${written}, so it will not load on the page.`,
    };
  }

  if (!EMBED_UPLOADS.has(path.extname(file).slice(1).toLowerCase())) {
    return {
      note: `Left ${written} as written: an embed uploads images, video, audio and PDF only. Use \`sumibako attach\` for other files.`,
    };
  }

  let root = gitRoot(baseDir) ?? baseDir;
  try {
    root = fs.realpathSync(root);
  } catch {
    // Compared as it stands.
  }
  if (!isInside(root, file)) {
    return {
      note: `Left ${written} as written: it is outside ${root}. Use \`sumibako attach\` to add it deliberately.`,
    };
  }

  return { file };
}

/**
 * An embed, re-pointed at the stored copy of its file.
 *
 * A picture keeps the alt text and caption its author wrote. Anything else is
 * known to the page by its file name - that is how `![demo.mp4](...)` is read
 * as a video rather than an image - so the name takes the alt text's place,
 * and what was written there becomes the caption unless there already is one.
 */
function hostedEmbed(embed, stored) {
  if (stored.kind === "image") {
    return `![${embed.alt}](${stored.url}${embed.title ? ` ${embed.title}` : ""})`;
  }
  // A type the vault has no block for goes on the page as the link it sent.
  if (stored.kind === "link" || !stored.markdown.endsWith(")")) {
    return stored.markdown;
  }

  const alt = embed.alt.trim();
  const caption =
    embed.title ||
    (alt && alt !== stored.name ? `"${alt.replace(/(["\\])/g, "\\$1")}"` : "");
  return caption
    ? `${stored.markdown.slice(0, -1)} ${caption})`
    : stored.markdown;
}

/** Sends one file's bytes to where the API said, and returns its storage id. */
async function sendBytes(uploadUrl, entry, contentType) {
  let response;
  try {
    // To storage directly, and without the token: this address is not the
    // API, and it is already signed for this one upload.
    response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType || "application/octet-stream" },
      body: fs.readFileSync(entry.file),
    });
  } catch {
    die(
      `Could not upload ${entry.name}.`,
      "Check your connection and run the same command again.",
    );
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Handled below, with every other answer that is not a storage id.
  }
  if (!response.ok || typeof payload?.storageId !== "string") {
    die(
      `Could not upload ${entry.name} (HTTP ${response.status}).`,
      "Run the same command again.",
    );
  }
  return payload.storageId;
}

/**
 * Stores files in the vault and returns what the API said about each, keyed by
 * path: its address, what kind of block it is, and the Markdown line for it.
 *
 * Nothing is written to a page here. If a file does not fit the plan the API
 * refuses the whole batch before any of it is sent, and this stops with its
 * message, so a page is never filed with one of its pictures missing.
 */
async function uploadFiles(paths) {
  const entries = paths.map((file) => {
    const size = fs.statSync(file).size;
    if (size === 0) die(`${file} is empty.`);
    return {
      file,
      name: path.basename(file),
      size,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex"),
    };
  });

  const misread = () =>
    die(
      "The server answered in a way this version does not understand.",
      "Update with: npx sumibako@latest",
    );

  const stored = new Map();
  for (let at = 0; at < entries.length; at += FILES_PER_REQUEST) {
    const batch = entries.slice(at, at + FILES_PER_REQUEST);

    const asked = await callApi("POST", "/v1/files/upload", {
      retry: true,
      body: {
        files: batch.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
      },
    });
    if (!Array.isArray(asked.files) || asked.files.length !== batch.length) {
      misread();
    }

    const sent = [];
    for (const [index, answer] of asked.files.entries()) {
      const entry = batch[index];
      if (answer.stored) {
        stored.set(entry.file, answer);
        console.log(dim(`Already stored ${entry.name}`));
        continue;
      }
      sent.push({
        entry,
        storageId: await sendBytes(answer.uploadUrl, entry, answer.contentType),
      });
    }
    if (sent.length === 0) continue;

    const kept = await callApi("POST", "/v1/files", {
      retry: true,
      body: {
        files: sent.map(({ entry, storageId }) => ({
          storageId,
          name: entry.name,
        })),
      },
    });
    if (!Array.isArray(kept.files) || kept.files.length !== sent.length) {
      misread();
    }
    for (const [index, file] of kept.files.entries()) {
      stored.set(sent[index].entry.file, file);
      console.log(
        `${green("Uploaded")} ${file.name} ${dim(`(${formatBytes(file.size)})`)}`,
      );
    }
  }

  return stored;
}

/**
 * Uploads the local files a piece of Markdown embeds, and returns the Markdown
 * pointing at the stored copies.
 *
 * `baseDir` is what a relative path is relative to: the Markdown file's own
 * folder when it came from a file, and the working directory when it came
 * from the command line or a pipe.
 *
 * `notes` says which embeds were left as written and why. They are printed
 * with the result, because the caller is usually an agent that will not look
 * at the page and would otherwise never learn that a picture is missing.
 */
async function embedLocalFiles(markdown, baseDir) {
  const notes = new Set();
  const wanted = [];

  for (const embed of findEmbeds(markdown)) {
    const located = locateEmbed(embed.destination, baseDir);
    if (!located) continue;
    if (located.note) notes.add(located.note);
    else wanted.push({ embed, file: located.file });
  }
  if (wanted.length === 0) return { markdown, notes: [...notes] };

  const stored = await uploadFiles([...new Set(wanted.map(({ file }) => file))]);

  // Last first, so the positions of the ones still to do stay true.
  let rewritten = markdown;
  for (const { embed, file } of wanted.sort(
    (a, b) => b.embed.start - a.embed.start,
  )) {
    rewritten =
      rewritten.slice(0, embed.start) +
      hostedEmbed(embed, stored.get(file)) +
      rewritten.slice(embed.end);
  }
  return { markdown: rewritten, notes: [...notes] };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** Prints what a freshly connected machine may do. */
function reportSignedIn(plan, scopes) {
  console.log(
    `${green("Connected.")} Plan ${bold(plan)}, can ${scopes
      .map((scope) => scope.replace("pages:", ""))
      .join(", ")}.`,
  );
  console.log(dim(`Token saved to ${CONFIG_FILE}`));
}

/**
 * Connects this machine.
 *
 * Three ways in, in the order they are checked. `--token` for somebody pasting
 * one deliberately and for scripts; a browser approval for everybody else; and
 * `SUMIBAKO_TOKEN` in the environment, which needs no command at all and is
 * why CI never reaches this function.
 *
 * The browser half waits, unlike the connect flow inside `publish`. That
 * difference is the point: a person who typed `login` is sitting there and
 * expects the command to finish when they are done approving, while an agent
 * that hit a missing token needs the link and its turn back.
 */
async function login(flags) {
  const api = typeof flags.api === "string" ? flags.api.replace(/\/+$/, "") : undefined;
  const base = api ?? resolveApi();

  let token = typeof flags.token === "string" ? flags.token.trim() : "";

  // A pasted token still has to work before it is saved, so a mistyped one
  // fails here rather than halfway through the next session, and a failed
  // login leaves whatever was configured before it untouched.
  if (token) {
    const who = await callApi("GET", "/v1/whoami", { token, api, retry: true });
    const config = readConfig();
    delete config.pending;
    writeConfig({ ...config, token, ...(api ? { api } : {}) });
    reportSignedIn(who.plan, who.scopes);
    return;
  }

  const pending = readPending(base) ?? (await startConnect(base));

  console.log(`Open this to connect ${bold(describeClient())}:`);
  console.log(pending.verificationUrl);
  console.log();
  console.log(dim(`The page should show the code ${bold(pending.userCode)}.`));

  if (process.stdout.isTTY) void openInBrowser(pending.verificationUrl);

  const remaining = Math.max(0, (pending.expiresAt ?? 0) - Date.now());
  if (remaining === 0) {
    die("That request expired.", "Run `npx sumibako login` again.");
  }

  console.log();
  console.log(dim("Waiting for you to approve it..."));

  const approved = await redeemPending(base, pending, remaining);
  if (!approved) {
    die(
      "The request was not approved.",
      "Run `npx sumibako login` again, or pass --token to paste one instead.",
    );
  }

  if (api) writeConfig({ ...readConfig(), api });
  reportSignedIn(approved.plan, approved.scopes);
}

function logout() {
  const config = readConfig();
  delete config.token;
  // Also the half-finished connection, if there is one. Leaving it would let
  // the next command silently pick up a token from a request made before the
  // person asked to be signed out.
  delete config.pending;
  writeConfig(config);
  console.log(`${green("Signed out.")} The token was removed from this machine.`);
  console.log(dim("Revoke it in Settings if it may have leaked."));
}

/**
 * Who may open the link, from the flags, or undefined to keep what it has.
 *
 * `--public` alone does not choose. A page its owner put behind a passcode
 * stays behind it when it is published again, which is the whole reason the
 * skill can tell agents to re-run `publish --public` after every revision.
 * Opening a locked page to everyone takes `--anyone`, said out loud.
 */
function accessFromFlags(flags) {
  if (flags.passcode === true && flags.anyone === true) {
    die(
      "--passcode and --anyone contradict each other.",
      "Pass --passcode to require one, or --anyone to let anyone with the link open it.",
    );
  }
  if (flags["new-passcode"] === true && flags.anyone === true) {
    die("--new-passcode only makes sense for a page behind a passcode.");
  }
  if (flags.passcode === true || flags["new-passcode"] === true) return "passcode";
  if (flags.anyone === true) return "anyone";
  return undefined;
}

/**
 * How long the link should last, from `--expires`, or undefined to keep what
 * it has. Checked here so a typo is refused before anything is sent, with
 * the three answers the server takes.
 */
function expiresFromFlags(flags) {
  if (flags.expires === undefined) return undefined;
  const value = typeof flags.expires === "string" ? flags.expires.trim().toLowerCase() : "";
  if (value === "7d" || value === "30d" || value === "never") return value;
  die(
    "--expires takes 7d, 30d or never.",
    "Example: sumibako publish docs/plan.md --public --expires 7d",
  );
}

/** "Mon 30 Nov 2026" from a time the API sent, for the line under a link. */
const dayOf = (at) =>
  new Date(at).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

async function publish(positional, flags) {
  const file = positional[0];
  if (!file) {
    die(
      "Which file?",
      "Usage: sumibako publish <file.md> [--public | --passcode]",
    );
  }

  const source = readMarkdown(file);
  if (!source.trim()) die(`${file} is empty.`);

  // Before the page is written, so the page that arrives has its pictures.
  const { markdown, notes } = await embedLocalFiles(
    source,
    file === "-" ? process.cwd() : path.dirname(path.resolve(file)),
  );

  const key =
    typeof flags.key === "string"
      ? flags.key
      : flags.new === true || file === "-"
        ? undefined
        : defaultKey(file);

  const access = accessFromFlags(flags);
  const expires = expiresFromFlags(flags);
  // A level is a way of being on the web, and so is an expiry, so choosing
  // either publishes.
  const wantsPublic =
    flags.public === true ||
    flags.publish === true ||
    access !== undefined ||
    expires !== undefined;

  const result = await callApi("POST", "/v1/pages", {
    retry: true,
    body: {
      markdown,
      externalId: key,
      // Where the page is filed and what its key is unique within. Sent for a
      // page with no key too, so it still lands in its project's folder.
      project: projectFor(flags, file === "-" ? process.cwd() : file),
      title: typeof flags.title === "string" ? flags.title : undefined,
      // One emoji. Also read from an `icon:` frontmatter line by the server,
      // which is the way to make it travel with the file; the flag wins.
      icon: typeof flags.icon === "string" ? flags.icon : undefined,
      // A banner's name, or "none". The same two ways in as the icon: this
      // flag, or a `cover:` line in the frontmatter, and the flag wins.
      cover: coverFlag(flags),
      parentDocument: typeof flags.parent === "string" ? flags.parent : undefined,
      publish: wantsPublic ? true : undefined,
      access,
      newPasscode: flags["new-passcode"] === true ? true : undefined,
      expires,
    },
  });

  report(result, { verb: result.created ? "Created" : "Updated", notes });

  // Said once, when it matters: somebody asked for "public" and the page
  // kept the lock its owner put on it.
  if (
    access === undefined &&
    wantsPublic &&
    result.access === "passcode"
  ) {
    console.log(
      dim(
        "It stays behind its passcode. Pass --anyone to let anyone with the link open it.",
      ),
    );
  }
}

/**
 * Works out whether an argument names a file on disk or a page id.
 *
 * A file that exists is keyed by its repo path, the same way `publish` filed
 * it, within the same project. Anything else is taken to be a page id, which
 * is what someone pastes after copying it out of a URL.
 *
 * A key given with --key is looked up in the project --project names, and in
 * none otherwise, rather than in the repository the command happens to be run
 * from: the server then finds the page wherever it was filed, and asks for
 * --project only when two projects hold the same key.
 */
function targetFor(argument, flags) {
  if (typeof flags.key === "string") {
    return {
      externalId: flags.key,
      project: typeof flags.project === "string" ? flags.project : undefined,
    };
  }
  if (!argument) return {};
  if (fs.existsSync(argument)) {
    return {
      externalId: defaultKey(argument),
      project: projectFor(flags, argument),
    };
  }
  return { documentId: argument };
}

/**
 * Adds to a page without sending it back.
 *
 * The running-log case, which `publish` handles badly: filing a note at the
 * end of a session with `publish` means reading the whole page, adding a line
 * and writing all of it again. Here the text to add is the only thing that
 * crosses the wire.
 *
 * Words after the target are the text. With none, it is read from stdin, so
 * `git log -1 --format=%s | sumibako append CHANGELOG.md` works.
 *
 * With --key the key is the target, so every word is text. Reading the first
 * word as a target anyway threw it away along with the text after it, and
 * `append --key log "text"` then sat waiting on stdin for text it had been
 * given.
 */
async function append(positional, flags) {
  const keyed = typeof flags.key === "string";
  const target = targetFor(keyed ? undefined : positional[0], flags);
  if (!target.documentId && !target.externalId) {
    die(
      "Which page?",
      "Usage: sumibako append <file.md | page-id> \"text\", or append --key <key> \"text\"",
    );
  }

  const inline = positional.slice(keyed ? 0 : 1).join(" ");
  const text = inline || fs.readFileSync(0, "utf8");
  if (!text.trim()) {
    die("Nothing to add.", "Pass the text as an argument or pipe it in.");
  }

  // Text typed here has no file of its own, so a path in it is relative to
  // where the command was run.
  const { markdown, notes } = await embedLocalFiles(text, process.cwd());

  const result = await callApi("PATCH", "/v1/pages", {
    body: {
      ...target,
      [flags.prepend === true ? "prepend" : "append"]: markdown,
    },
  });
  report(result, {
    verb: flags.prepend === true ? "Prepended to" : "Appended to",
    notes,
  });
}

/**
 * Adds files to a page that already exists.
 *
 * The other way a file reaches a page, for when there is no Markdown to embed
 * it in: the page was written in the app, or the session that wrote it has
 * ended, and somebody wants the PDF on it. Each file becomes a block of its
 * own at the end of the page - a picture, a player, or a file to download.
 *
 * Any file may be named, of any type and from anywhere on the machine, which
 * an embed may not. The difference is that here somebody typed its name.
 *
 * The first word is the page and the rest are files, except with --key, where
 * the key is the page and every word is a file. Same rule as `append`.
 */
async function attach(positional, flags) {
  const keyed = typeof flags.key === "string";
  const usage =
    "Usage: sumibako attach <file.md | page-id> <file...>, or attach --key <key> <file...>";
  const target = targetFor(keyed ? undefined : positional[0], flags);
  if (!target.documentId && !target.externalId) die("Which page?", usage);

  const named = positional.slice(keyed ? 0 : 1);
  if (named.length === 0) die("Which files?", usage);

  const files = named.map((name) => {
    if (!fs.existsSync(name)) die(`No such file: ${name}`);
    if (fs.statSync(name).isDirectory()) {
      die(`${name} is a directory. Name the files to attach.`);
    }
    return path.resolve(name);
  });

  const stored = await uploadFiles([...new Set(files)]);

  const result = await callApi("PATCH", "/v1/pages", {
    body: {
      ...target,
      // A blank line between them, so each is a block of its own.
      [flags.prepend === true ? "prepend" : "append"]: files
        .map((file) => stored.get(file).markdown)
        .join("\n\n"),
    },
  });
  report(result, { verb: "Attached to" });
}

/**
 * Replaces one exact piece of text in a page.
 *
 * `--find` matches against the page's Markdown, which is what `open
 * --markdown` prints, so the way to use this is to look first and paste. The
 * API refuses a match that is not unique rather than guessing, so a failure
 * here means "say more", not "try again".
 */
async function edit(positional, flags) {
  const target = targetFor(positional[0], flags);
  if (!target.documentId && !target.externalId) {
    die(
      "Which page?",
      "Usage: sumibako edit <file.md | page-id> --find <old> --replace <new>",
    );
  }

  const rename = typeof flags.title === "string" ? flags.title : undefined;
  const icon = typeof flags.icon === "string" ? flags.icon : undefined;
  const cover = coverFlag(flags);
  const find = typeof flags.find === "string" ? flags.find : undefined;
  if (
    find === undefined &&
    rename === undefined &&
    icon === undefined &&
    cover === undefined
  ) {
    die(
      "Nothing to change.",
      "Pass --find with --replace, --title to rename the page, --icon to set its icon, or --cover to set its banner.",
    );
  }
  // An empty --replace is a deletion, and has to survive the default below.
  // What is put in may embed a local file, which is how a picture is placed
  // somewhere other than the end of a page.
  const written = typeof flags.replace === "string" ? flags.replace : "";
  const { markdown: replace, notes } =
    find !== undefined
      ? await embedLocalFiles(written, process.cwd())
      : { markdown: written, notes: [] };

  const result = await callApi("PATCH", "/v1/pages", {
    body: {
      ...target,
      ...(find !== undefined ? { find, replace } : {}),
      ...(rename !== undefined ? { title: rename } : {}),
      ...(icon !== undefined ? { icon } : {}),
      ...(cover !== undefined ? { cover } : {}),
    },
  });
  report(result, { verb: "Edited", notes });
}

async function unpublish(positional, flags) {
  const target = targetFor(positional[0], flags);
  if (!target.documentId && !target.externalId) {
    die("Which page?", "Usage: sumibako unpublish <file.md | page-id>");
  }

  const result = await callApi("POST", "/v1/pages/publish", {
    retry: true,
    body: { ...target, publish: false },
  });
  console.log(`${green("Taken down.")} ${titled(result)} is private again.`);
  console.log(dim(result.url));
}

async function open(positional, flags) {
  const target = targetFor(positional[0], flags);
  if (!target.documentId && !target.externalId) {
    die("Which page?", "Usage: sumibako open <file.md | page-id>");
  }

  const page = await callApi("GET", "/v1/pages", {
    retry: true,
    query: {
      id: target.documentId,
      externalId: target.externalId,
      project: target.project,
    },
  });
  console.log(titled(page));
  console.log(page.url);
  if (page.publicUrl) console.log(green(page.publicUrl));
  if (page.publicUrl && page.passcode) {
    console.log(`${bold("Passcode:")} ${page.passcode}`);
  }
  if (page.publicUrl && page.expiresAt) {
    console.log(`${bold("Expires:")}  ${dayOf(page.expiresAt)}`);
  }
  if (!page.publicUrl && page.expiredAt) {
    console.log(dim(`The link expired on ${dayOf(page.expiredAt)}. The page is private.`));
  }

  // Two names for one thing. `--text` came first and is in people's scripts;
  // Markdown is strictly the better answer, because it is what you edit and
  // send back, so both flags print it rather than keeping a worse output alive
  // for the sake of a flag name.
  if (flags.markdown === true || flags.text === true) {
    console.log();
    console.log(page.markdown || page.text);
    for (const warning of page.markdownWarnings ?? []) {
      console.log(yellow(`note   ${warning}`));
    }
  }
}

async function search(positional) {
  // No words is a question too: "what is in here". It lists the newest pages
  // rather than explaining the command to somebody who has just been handed a
  // vault they have never seen.
  const term = positional.join(" ").trim();

  const { results } = await callApi("GET", "/v1/pages/search", {
    retry: true,
    query: { q: term || undefined, limit: term ? undefined : 20 },
  });

  if (results.length === 0) {
    console.log(dim(term ? "Nothing matched." : "This vault has no pages yet."));
    return;
  }
  for (const page of results) {
    const marker = page.publicUrl
      ? green(page.access === "passcode" ? "  passcode" : "  public")
      : "";
    console.log(`${titled(page)}${marker}`);
    console.log(dim(`  ${page.publicUrl ?? page.url}`));
  }
}

async function whoami() {
  const who = await callApi("GET", "/v1/whoami", { retry: true });
  const usage = await callApi("GET", "/v1/usage", { retry: true });
  console.log(`Plan ${bold(who.plan)} at ${who.site}`);
  console.log(`Permissions: ${who.scopes.join(", ")}`);
  console.log(
    `Pages: ${usage.documents} of ${limit(usage.maxDocuments)}   Published: ${usage.published} of ${limit(usage.maxPublished)}`,
  );
}

const limit = (value) => (value === null || !Number.isFinite(value) ? "unlimited" : value);

/** A page's title as the sidebar shows it: its icon first, when it has one. */
const titled = (page) =>
  `${page.icon ? `${page.icon} ` : ""}${bold(page.title)}`;

/** Prints the outcome of a write, link last so it is the easiest thing to copy. */
function report(result, { verb, notes = [] }) {
  console.log(`${green(verb)} ${titled(result)}`);
  // What this command left alone first, then what the server changed.
  for (const warning of [...notes, ...(result.warnings ?? [])]) {
    console.log(`${yellow("note")}   ${warning}`);
  }
  console.log(dim(result.url));
  if (result.publicUrl) {
    console.log();
    console.log(`${bold("Share this:")} ${result.publicUrl}`);
    // The link opens a lock screen without this, so it is printed right under
    // it, in the same form a person types it.
    if (result.passcode) {
      console.log(`${bold("Passcode:")}   ${result.passcode}`);
    }
    // The day the link stops working, which the person sending it should
    // know before they send it.
    if (result.expiresAt) {
      console.log(`${bold("Expires:")}    ${dayOf(result.expiresAt)}`);
    }
    if (result.passcode) {
      console.log(
        dim("Send the passcode separately from the link. It opens nothing without it."),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// init: setting up the coding agents on this machine
// ---------------------------------------------------------------------------

/*
  `sumibako init` finds Claude Code, Codex and Cursor on this machine and, with
  a yes for each, gives every one the skill, the MCP server and, for the two
  that can run a hook, one that files a plan into the vault, privately, as
  soon as it is made (Epic 4 of the direction plan in the repository this
  ships from). `init --undo` takes all of it back out.

  Three rules hold the design up.

  - Nothing is touched without a record of what it was. Every file is copied
    aside before its first change, and `~/.sumibako/init.json` lists what was
    made and what was changed. `--undo` puts a file back byte for byte when
    nothing else has written to it since, and otherwise takes out only what
    init added, because a settings file is also its owner's and theirs to
    keep editing.
  - A hook never stops an agent. It runs in the background, exits 0 whatever
    happens, and writes what went wrong to `~/.sumibako/hook.log`, never to
    the agent's screen.
  - A hook files a page and does nothing else: it never sends `publish`, so a
    plan arrives private and a page somebody published stays as published as
    they left it, showing the latest revision like any re-file does.

  Where each agent keeps things was read from its own documentation and
  source on 2026-11-23: Claude Code's hooks reference and skills page,
  Codex's `codex-rs/hooks` and skill roots, Cursor's skills, MCP and hooks
  pages. Cursor gets no hook: its plan mode has no hook of its own, and the
  plan this follows decided to rely on the skill there.
*/

const SETUP_FILE = path.join(CONFIG_DIR, "init.json");
const BACKUP_DIR = path.join(CONFIG_DIR, "init-backup");
const HOOK_LOG = path.join(CONFIG_DIR, "hook.log");
/** What every hook init installs runs, so init and --undo can recognise their own. */
const HOOK_MARK = /\bsumibako(@\S+)? (hook|brief)\b/;
/*
  --prefer-offline: npx uses the copy it has rather than asking the registry
  first, which is the difference between about 0.25s and up to 1.5s on every
  run, measured 2026-11-23. A new release reaches a hook once npx's cache
  takes it, which the brief's one-second budget is worth.
*/
const hookCommand = (agent) => `npx -y --prefer-offline sumibako hook ${agent}`;
const briefCommand = (agent) => `npx -y --prefer-offline sumibako brief --hook ${agent}`;
const PLAN_ICON = "\u{1F5FA}\u{FE0F}";

/** The MCP address on the same site as the API this CLI talks to. */
function mcpUrlFor(api) {
  const base = api.replace(/\/+$/, "");
  return base.endsWith("/api/agent")
    ? `${base.slice(0, -"/api/agent".length)}/api/mcp`
    : `${base}/mcp`;
}

/** The indentation a JSON file already uses, so a change does not reflow it. */
function indentOf(text) {
  const match = /\n([ \t]+)"/.exec(text ?? "");
  return match ? match[1] : 2;
}

function parseJsonFile(text, what) {
  if (!text || !text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Reported below.
  }
  throw new Error(`${what} is not a JSON object, so it was left alone.`);
}

const writeJson = (value, original) =>
  `${JSON.stringify(value, null, indentOf(original))}\n`;

const isOurs = (handler) =>
  typeof handler?.command === "string" && HOOK_MARK.test(handler.command);

/**
 * A hooks file (Claude Code's settings.json or Codex's hooks.json) with our
 * hook for one event added, or the one already there brought up to date.
 * Both read `{ hooks: { Event: [{ matcher?, hooks: [{ type, command }] }] } }`.
 */
function withHook(text, { event, matcher, command, what, sync = false }) {
  const settings = parseJsonFile(text, what);
  const hooks =
    settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
  // A plan hook runs in the background; the brief cannot, because its output
  // is what the session starts with, so it gets a short timeout instead.
  const handler = sync
    ? { type: "command", command, timeout: 5 }
    : { type: "command", command, async: true, timeout: 120 };
  let found = false;
  const next = groups.map((group) => {
    if (!Array.isArray(group?.hooks) || !group.hooks.some(isOurs)) return group;
    found = true;
    return {
      ...group,
      ...(matcher ? { matcher } : {}),
      hooks: group.hooks.map((one) => (isOurs(one) ? handler : one)),
    };
  });
  if (!found) next.push({ ...(matcher ? { matcher } : {}), hooks: [handler] });
  return writeJson({ ...settings, hooks: { ...hooks, [event]: next } }, text);
}

/** The same file with every hook of ours taken out, and anything left empty by that. */
function withoutHooks(text, what) {
  const settings = parseJsonFile(text, what);
  if (!settings.hooks || typeof settings.hooks !== "object") return text;
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups
      .map((group) =>
        Array.isArray(group?.hooks)
          ? { ...group, hooks: group.hooks.filter((one) => !isOurs(one)) }
          : group,
      )
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  return writeJson(replaceKey(settings, "hooks", Object.keys(hooks).length ? hooks : undefined), text);
}

/** An object with one key replaced in place, or dropped when `value` is undefined. */
function replaceKey(object, key, value) {
  const out = {};
  for (const [name, current] of Object.entries(object)) {
    if (name !== key) out[name] = current;
    else if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Cursor's mcp.json with the server added. */
function withCursorMcp(text, url) {
  const config = parseJsonFile(text, "~/.cursor/mcp.json");
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  return writeJson({ ...config, mcpServers: { ...servers, sumibako: { url } } }, text);
}

function withoutCursorMcp(text) {
  const config = parseJsonFile(text, "~/.cursor/mcp.json");
  if (!config.mcpServers?.sumibako) return text;
  const { sumibako: _gone, ...servers } = config.mcpServers;
  return writeJson(
    replaceKey(config, "mcpServers", Object.keys(servers).length ? servers : undefined),
    text,
  );
}

const CODEX_TABLE = "[mcp_servers.sumibako]";

/**
 * Codex's config.toml with the server's table appended. Text, not a TOML
 * library: the file is its owner's, comments and all, and appending a table
 * at the end is the one edit that cannot disturb anything above it.
 */
function withCodexMcp(text, url) {
  const current = text ?? "";
  if (current.split(/\r?\n/).some((line) => line.trim() === CODEX_TABLE)) return current;
  const gap = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${gap}${CODEX_TABLE}\nurl = ${JSON.stringify(url)}\n`;
}

/** The table taken back out: its header and its lines, up to the next table. */
function withoutCodexMcp(text) {
  const lines = (text ?? "").split("\n");
  const start = lines.findIndex((line) => line.trim() === CODEX_TABLE);
  if (start === -1) return text;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  const before = lines.slice(0, start);
  while (before.length && before[before.length - 1].trim() === "") before.pop();
  const after = lines.slice(end);
  const joined = [...before, ...after].join("\n");
  return joined.trim() === "" ? "" : `${joined.replace(/\n+$/, "")}\n`;
}

// ---------------------------------------------------------------------------
// The plan a hook files
// ---------------------------------------------------------------------------

const firstHeading = (markdown) => /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();

/**
 * The plan Claude Code just had approved, out of a PostToolUse payload for
 * ExitPlanMode, or null.
 *
 * Claude Code writes the plan to a file in `~/.claude/plans/` before asking
 * for approval, and its docs say the plan and its path are put into the
 * tool's input before a hook sees it, without naming the fields. So this
 * reads what is there in order: the plan text, a path to the file, and last
 * the newest plan file written in the past half hour.
 */
function claudePlanFrom(input, { readFile, newestPlan }) {
  if (input?.tool_name && input.tool_name !== "ExitPlanMode") return null;
  const fields = [input?.tool_input, input?.tool_response].filter(
    (value) => value && typeof value === "object",
  );
  const pick = (names) =>
    fields
      .flatMap((value) => names.map((name) => value[name]))
      .find((value) => typeof value === "string" && value.trim());
  const file = pick(["planFilePath", "filePath", "plan_file_path", "path"]);
  let markdown = pick(["plan"]);
  let source = typeof file === "string" && file.endsWith(".md") ? file : null;
  if (!markdown && source) markdown = readFile(source);
  if (!markdown) {
    source = newestPlan();
    markdown = source ? readFile(source) : null;
  }
  if (!markdown || !markdown.trim()) return null;
  const session = String(input?.session_id ?? "").replace(/[^a-zA-Z0-9-]/g, "");
  return {
    markdown: markdown.trim(),
    key: source
      ? `plans/${path.basename(source)}`
      : `plans/claude-code-${session || "plan"}.md`,
    title: firstHeading(markdown) ? undefined : "Plan",
  };
}

/**
 * The plan Codex proposed in plan mode, out of a Stop payload, or null.
 *
 * Codex has no hook for a plan being approved. In plan mode it writes the
 * plan inside a `<proposed_plan>` block in its reply (`codex-rs/utils/
 * stream-parser/src/proposed_plan.rs`), and Stop hands over that reply, so
 * the plan is filed as proposed, one page per session that each revision
 * replaces.
 */
function codexPlanFrom(input) {
  const message = input?.last_assistant_message;
  if (typeof message !== "string") return null;
  const blocks = [...message.matchAll(/<proposed_plan>([\s\S]*?)<\/proposed_plan>/g)];
  const markdown = blocks.at(-1)?.[1]?.trim();
  if (!markdown) return null;
  const session = String(input?.session_id ?? "").replace(/[^a-zA-Z0-9-]/g, "");
  return {
    markdown,
    key: `plans/codex-${session || "plan"}.md`,
    title: firstHeading(markdown) ? undefined : "Proposed plan",
  };
}

function logHook(line) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const stamp = new Date().toISOString();
    let previous = "";
    try {
      previous = fs.readFileSync(HOOK_LOG, "utf8").slice(-50_000);
    } catch {
      // A first line.
    }
    fs.writeFileSync(HOOK_LOG, `${previous}${stamp} ${line}\n`);
  } catch {
    // Nowhere left to say it.
  }
}

function readStdin(limitMs = 5000) {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(done, limitMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

/** The newest `.md` in Claude Code's plans folder, written in the last half hour. */
function newestClaudePlan(home) {
  let folder = path.join(home, ".claude", "plans");
  try {
    const settings = JSON.parse(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
    );
    if (typeof settings.plansDirectory === "string" && settings.plansDirectory.trim()) {
      folder = settings.plansDirectory.replace(/^~(?=$|\/)/, home);
    }
  } catch {
    // The default folder, then.
  }
  try {
    const newest = fs
      .readdirSync(folder)
      .filter((name) => name.endsWith(".md"))
      .map((name) => {
        const full = path.join(folder, name);
        return { full, at: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at)[0];
    return newest && Date.now() - newest.at < 30 * 60 * 1000 ? newest.full : null;
  } catch {
    return null;
  }
}

/**
 * `sumibako hook <agent>`: what an installed hook runs. Reads the payload on
 * stdin, files the plan in it, and exits 0 whatever happened.
 */
async function hook(positional) {
  const agent = positional[0];
  try {
    const raw = await readStdin();
    let input = {};
    try {
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      logHook(`${agent}: the payload was not JSON`);
      return;
    }
    const readFile = (file) => {
      try {
        return fs.readFileSync(file, "utf8");
      } catch {
        return null;
      }
    };
    const plan =
      agent === "claude-code"
        ? claudePlanFrom(input, { readFile, newestPlan: () => newestClaudePlan(os.homedir()) })
        : agent === "codex"
          ? codexPlanFrom(input)
          : null;
    if (!plan) return;

    // Never the connect flow: it prints a link and exits 3, and nobody is
    // looking at a hook's output.
    const token = resolveToken();
    if (!token) {
      logHook(`${agent}: not connected, so the plan was not filed. Run: npx sumibako login`);
      return;
    }
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    const response = await fetch(`${resolveApi()}/v1/pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Sumibako-Agent": agent,
      },
      body: JSON.stringify({
        markdown: plan.markdown,
        externalId: plan.key,
        project: projectOf(cwd) ?? undefined,
        title: plan.title,
        icon: PLAN_ICON,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      logHook(`${agent}: filing the plan failed with ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
  } catch (error) {
    logHook(`${agent}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.exitCode = 0;
  }
}

// ---------------------------------------------------------------------------
// What init does, worked out before anything is written
// ---------------------------------------------------------------------------

function onPath(command) {
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const folder of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const extension of extensions) {
      try {
        fs.accessSync(path.join(folder, command + extension), fs.constants.X_OK);
        return true;
      } catch {
        // Not here.
      }
    }
  }
  return false;
}

const exists = (file) => fs.existsSync(file);

/**
 * The agents on this machine and, for each, the steps init would take.
 *
 * A skill goes where the agent reads skills from. Cursor also reads Claude
 * Code's and Codex's folders, so it is given its own copy only when neither
 * has one, rather than seeing the same skill twice.
 */
function planSetup(home, api) {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const mcpUrl = mcpUrlFor(api);
  const skillIn = (root) => path.join(root, "sumibako", "SKILL.md");
  const sharedSkill = skillIn(path.join(home, ".agents", "skills"));
  const agents = [];

  if (exists(path.join(home, ".claude")) || onPath("claude")) {
    agents.push({
      id: "claude-code",
      name: "Claude Code",
      steps: [
        { kind: "skill", file: skillIn(path.join(home, ".claude", "skills")) },
        { kind: "claude-mcp", url: mcpUrl },
        {
          kind: "hook",
          file: path.join(home, ".claude", "settings.json"),
          event: "PostToolUse",
          matcher: "ExitPlanMode",
          what: "~/.claude/settings.json",
        },
        {
          kind: "hook",
          brief: true,
          file: path.join(home, ".claude", "settings.json"),
          event: "SessionStart",
          what: "~/.claude/settings.json",
        },
      ],
    });
  }
  if (exists(codexHome) || onPath("codex")) {
    agents.push({
      id: "codex",
      name: "Codex",
      steps: [
        {
          kind: "skill",
          file: exists(sharedSkill) ? sharedSkill : skillIn(path.join(codexHome, "skills")),
        },
        { kind: "toml-mcp", file: path.join(codexHome, "config.toml"), url: mcpUrl },
        {
          kind: "hook",
          file: path.join(codexHome, "hooks.json"),
          event: "Stop",
          what: "~/.codex/hooks.json",
        },
        {
          kind: "hook",
          brief: true,
          file: path.join(codexHome, "hooks.json"),
          event: "SessionStart",
          what: "~/.codex/hooks.json",
        },
      ],
    });
  }
  if (exists(path.join(home, ".cursor")) || onPath("cursor") || onPath("cursor-agent")) {
    agents.push({
      id: "cursor",
      name: "Cursor",
      steps: [
        {
          kind: "cursor-skill",
          file: skillIn(path.join(home, ".cursor", "skills")),
          // Cursor reads these as well (its skills page, "for compatibility").
          readsAlready: [
            skillIn(path.join(home, ".claude", "skills")),
            skillIn(path.join(codexHome, "skills")),
            sharedSkill,
          ],
        },
        { kind: "json-mcp", file: path.join(home, ".cursor", "mcp.json"), url: mcpUrl },
      ],
    });
  }
  return agents;
}

const tilde = (file) => {
  const home = os.homedir();
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file;
};

function describeStep(step) {
  switch (step.kind) {
    case "skill":
      return `the skill, at ${tilde(step.file)}`;
    case "cursor-skill":
      return "the skill, unless Cursor already reads one from Claude Code's or Codex's folder";
    case "claude-mcp":
      return "the MCP server, with claude mcp add at user scope";
    case "toml-mcp":
    case "json-mcp":
      return `the MCP server, in ${tilde(step.file)}`;
    case "hook":
      if (step.brief) {
        return `a hook that starts each session with this project's recent pages (${tilde(step.file)})`;
      }
      return step.event === "Stop"
        ? `a hook that files each plan it proposes, privately (${tilde(step.file)})`
        : `a hook that files each plan you approve, privately (${tilde(step.file)})`;
    default:
      return step.text;
  }
}

// ---------------------------------------------------------------------------
// Writing, with a record of everything written
// ---------------------------------------------------------------------------

const sha = (text) => crypto.createHash("sha256").update(text ?? "").digest("hex");

function readSetup() {
  try {
    return JSON.parse(fs.readFileSync(SETUP_FILE, "utf8"));
  } catch {
    return { items: [] };
  }
}

function writeSetup(setup) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SETUP_FILE, `${JSON.stringify(setup, null, 2)}\n`);
}

/**
 * Writes one file and records it: created or changed, and where its
 * original went. A file init has already changed keeps the copy of what it
 * was before init first touched it, so running init twice still undoes to
 * the very beginning.
 */
function writeRecorded(setup, agent, kind, file, next) {
  const before = exists(file) ? fs.readFileSync(file, "utf8") : null;
  if (before === next) return "unchanged";
  let item = setup.items.find((entry) => entry.file === file);
  if (!item) {
    let backup = null;
    if (before !== null) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      backup = path.join(BACKUP_DIR, `${setup.items.length + 1}-${path.basename(file)}`);
      fs.copyFileSync(file, backup);
    }
    // Every folder this write is about to create, deepest first, so --undo
    // can take them away again and leave no empty folder behind.
    const madeFolders = [];
    for (let folder = path.dirname(file); !exists(folder); folder = path.dirname(folder)) {
      madeFolders.push(folder);
      if (path.dirname(folder) === folder) break;
    }
    item = { agent, kind, file, created: before === null, backup, madeFolders };
    setup.items.push(item);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  item.wrote = sha(next);
  writeSetup(setup);
  return before === null ? "added" : "updated";
}

function bundledSkill() {
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "SKILL.md"), "utf8");
}

/**
 * Whether Claude Code already has a server called sumibako at user scope.
 * Read from `~/.claude.json`, where `claude mcp add --scope user` keeps it,
 * rather than asked of `claude mcp get`, which connects to the server to
 * check its health and leaves logs behind.
 */
function claudeHasServer() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    return Boolean(config?.mcpServers?.sumibako);
  } catch {
    return false;
  }
}

function applyStep(setup, agent, step) {
  switch (step.kind) {
    case "skill":
      return writeRecorded(setup, agent, "skill", step.file, bundledSkill());
    case "cursor-skill": {
      // Decided now, not when the list was made: the person may have said no
      // to the agents whose copy Cursor would have read.
      const shared = step.readsAlready.find(exists);
      if (shared) return `reads ${tilde(shared)}, so no second copy`;
      return writeRecorded(setup, agent, "skill", step.file, bundledSkill());
    }
    case "hook": {
      const before = exists(step.file) ? fs.readFileSync(step.file, "utf8") : "";
      return writeRecorded(
        setup,
        agent,
        "hook",
        step.file,
        withHook(before, {
          ...step,
          sync: Boolean(step.brief),
          command: step.brief ? briefCommand(agent) : hookCommand(agent),
        }),
      );
    }
    case "toml-mcp": {
      const before = exists(step.file) ? fs.readFileSync(step.file, "utf8") : "";
      return writeRecorded(setup, agent, "toml-mcp", step.file, withCodexMcp(before, step.url));
    }
    case "json-mcp": {
      const before = exists(step.file) ? fs.readFileSync(step.file, "utf8") : "";
      return writeRecorded(setup, agent, "json-mcp", step.file, withCursorMcp(before, step.url));
    }
    case "claude-mcp": {
      if (!onPath("claude")) {
        return `skipped: claude is not on the PATH. Run: claude mcp add --transport http --scope user sumibako ${step.url}`;
      }
      if (claudeHasServer()) return "already there";
      execFileSync(
        "claude",
        ["mcp", "add", "--transport", "http", "--scope", "user", "sumibako", step.url],
        { stdio: "ignore", timeout: 30_000 },
      );
      if (!setup.items.some((entry) => entry.kind === "claude-mcp")) {
        setup.items.push({ agent, kind: "claude-mcp" });
        writeSetup(setup);
      }
      return "added";
    }
    default:
      return "";
  }
}

async function ask(question) {
  const readline = await import("node:readline/promises");
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

async function init(flags) {
  if (flags.undo === true) return undoInit();

  const home = os.homedir();
  const agents = planSetup(home, resolveApi());
  if (agents.length === 0) {
    console.log("No Claude Code, Codex or Cursor found on this machine.");
    console.log(dim(`For another agent, add the MCP server ${mcpUrlFor(resolveApi())}`));
    return;
  }

  console.log(bold("Found on this machine:"));
  for (const agent of agents) {
    console.log(`  ${bold(agent.name)}`);
    for (const step of agent.steps) console.log(dim(`    ${describeStep(step)}`));
  }
  console.log();

  if (flags["dry-run"] === true) {
    console.log(dim("Nothing was changed (--dry-run)."));
    return;
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  if (flags.yes !== true && !interactive) {
    console.log("Nothing was changed: there is no terminal here to say yes in.");
    console.log(dim("Run npx sumibako init --yes to set up everything listed, or run it in a terminal to choose."));
    process.exitCode = 1;
    return;
  }

  const setup = readSetup();
  setup.version = version();
  setup.updatedAt = new Date().toISOString();
  const notes = [];

  for (const agent of agents) {
    if (flags.yes !== true) {
      if (!(await ask(`Set up ${agent.name}?`))) continue;
    }
    let steps = agent.steps;
    const hookStep = steps.find((step) => step.kind === "hook" && !step.brief);
    if (hookStep && flags.yes !== true) {
      const wantsHook = await ask(
        `  File ${agent.id === "codex" ? "the plans Codex proposes" : "the plans you approve"} into Sumibako automatically, privately?`,
      );
      if (!wantsHook) steps = steps.filter((step) => step !== hookStep);
    }
    const briefStep = steps.find((step) => step.kind === "hook" && step.brief);
    if (briefStep && flags.yes !== true) {
      const wantsBrief = await ask(
        "  Start each session with a short list of this project's recent pages?",
      );
      if (!wantsBrief) steps = steps.filter((step) => step !== briefStep);
    }
    console.log(bold(agent.name));
    for (const step of steps) {
      try {
        const outcome = applyStep(setup, agent.id, step);
        if (step.kind === "cursor-skill" && outcome.startsWith("reads")) {
          console.log(`  ${green("shared")}  the skill: Cursor ${outcome}`);
          continue;
        }
        if (outcome.startsWith("skipped: ")) {
          console.log(`  ${yellow("skipped")}  ${outcome.slice("skipped: ".length)}`);
          continue;
        }
        console.log(`  ${green(outcome)}  ${describeStep(step)}`);
      } catch (error) {
        console.log(`  ${yellow("skipped")}  ${describeStep(step)}`);
        console.log(dim(`          ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (agent.id === "claude-code") {
      notes.push("Claude Code: run /mcp, pick sumibako and choose Authenticate to sign the MCP server in.");
    }
    if (agent.id === "codex") {
      notes.push("Codex: it asks you to trust the new hook the next time it starts. To sign the MCP server in, run: codex mcp login sumibako");
    }
    if (agent.id === "cursor") {
      notes.push("Cursor: open Settings, then MCP, and sign in to sumibako there.");
    }
  }

  console.log();
  for (const note of notes) console.log(dim(note));
  if (!resolveToken()) {
    console.log();
    console.log(`${bold("One more step:")} connect this machine, so the skill and the hooks can file pages.`);
    console.log("  npx sumibako login");
  }
  console.log();
  console.log(dim("npx sumibako init --undo takes all of this back out."));
}

function undoInit() {
  const setup = readSetup();
  if (!setup.items?.length) {
    console.log("Nothing to undo: init has not changed anything on this machine.");
    return;
  }
  for (const item of [...setup.items].reverse()) {
    if (item.kind === "claude-mcp") {
      try {
        execFileSync("claude", ["mcp", "remove", "sumibako", "--scope", "user"], {
          stdio: "ignore",
          timeout: 30_000,
        });
        console.log(`  ${green("removed")}  the MCP server from Claude Code`);
      } catch {
        console.log(`  ${yellow("left")}  the MCP server in Claude Code. Run: claude mcp remove sumibako --scope user`);
      }
      continue;
    }
    const file = item.file;
    const current = exists(file) ? fs.readFileSync(file, "utf8") : null;
    if (current === null) {
      console.log(`  ${dim("gone")}  ${tilde(file)}`);
      continue;
    }
    if (sha(current) === item.wrote) {
      // Nothing else wrote to it since: back exactly as it was.
      if (item.created) {
        fs.rmSync(file);
        for (const folder of item.madeFolders ?? []) {
          try {
            fs.rmdirSync(folder);
          } catch {
            // Something else lives there now.
            break;
          }
        }
        console.log(`  ${green("removed")}  ${tilde(file)}`);
      } else {
        fs.copyFileSync(item.backup, file);
        console.log(`  ${green("restored")}  ${tilde(file)}`);
      }
      continue;
    }
    // Edited since: take out only what init put in.
    try {
      const next =
        item.kind === "hook"
          ? withoutHooks(current, tilde(file))
          : item.kind === "json-mcp"
            ? withoutCursorMcp(current)
            : item.kind === "toml-mcp"
              ? withoutCodexMcp(current)
              : null;
      if (next === null) {
        console.log(`  ${yellow("left")}  ${tilde(file)}, which was changed after init`);
      } else {
        fs.writeFileSync(file, next);
        console.log(`  ${green("cleaned")}  ${tilde(file)} (changed since, so only Sumibako's part was taken out)`);
      }
    } catch (error) {
      console.log(`  ${yellow("left")}  ${tilde(file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  fs.rmSync(SETUP_FILE, { force: true });
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  console.log(dim("Done. Pages already filed stay in the vault."));
}

// ---------------------------------------------------------------------------
// brief: the project's recent pages, for an agent starting a session
// ---------------------------------------------------------------------------

/*
  Epic 5 of the direction plan, a four-week experiment: does an agent that is
  told what is already in the vault go and read it? `sumibako brief` prints
  the project's recent pages, one line each, and `init` can install a
  SessionStart hook in Claude Code and Codex that hands the same text to every
  new session. The weekly report counts the brief apart from reads, and the
  hook comes out of init if too few of the accounts that get one read.

  The hook has one second (the plan's acceptance criterion). npx costs about a
  quarter of that with --prefer-offline, measured on 2026-11-23, so the request
  gets `BRIEF_WAIT_MS` and no more; when it is slower, the copy kept from the
  last session in that project is used instead, saying how old it is.
*/

/** Roughly the most a brief may cost a session, in characters. */
const BRIEF_CAP = 1500;
const BRIEF_WAIT_MS = 650;
const BRIEF_CACHE_DIR = path.join(CONFIG_DIR, "brief");
/** A cached brief older than this is not worth showing. */
const BRIEF_CACHE_DAYS = 7;

const dateOnly = (at) => new Date(at).toISOString().slice(0, 10);

/**
 * The brief as text, never longer than `cap`. Pages are added newest first
 * until the next one would not fit; what is left over is counted, so the
 * agent knows to search rather than believe the list is everything.
 */
function renderBrief({ project, pages, total }, cap = BRIEF_CAP) {
  if (!pages?.length) return "";
  const head = [
    `Recent pages in the user's Sumibako vault for ${project}, newest first.`,
    `Read one with: npx sumibako open --key <key> --project ${project} --markdown (or open <id> for a page with no key).`,
    "",
  ].join("\n");
  let body = "";
  let shown = 0;
  for (const page of pages) {
    const handle = page.externalId ? `key ${page.externalId}` : `id ${page.documentId}`;
    const flags = page.publicUrl ? (page.access === "passcode" ? ", shared with a passcode" : ", published") : "";
    const line = `- ${page.title || "Untitled"} (${dateOnly(page.updatedAt)}, ${handle}${flags})${page.summary ? `\n  ${page.summary}` : ""}\n`;
    const more = total - (shown + 1);
    const tail = more > 0 ? `...and ${more} more: npx sumibako search <words>\n` : "";
    if ((head + body + line + tail).length > cap) break;
    body += line;
    shown += 1;
  }
  if (shown === 0) return "";
  const rest = total - shown;
  return `${head}${body}${rest > 0 ? `...and ${rest} more: npx sumibako search <words>\n` : ""}`.trimEnd();
}

function briefCacheFile(project) {
  return path.join(BRIEF_CACHE_DIR, `${sha(project).slice(0, 16)}.json`);
}

async function fetchBrief(project, limit, waitMs) {
  const token = resolveToken();
  if (!token) return { error: "not connected" };
  const url = new URL(`${resolveApi()}/v1/pages/brief`);
  url.searchParams.set("project", project);
  if (limit) url.searchParams.set("limit", String(limit));
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(runningAgent ? { "Sumibako-Agent": runningAgent } : {}),
    },
    signal: AbortSignal.timeout(waitMs),
  });
  if (!response.ok) return { error: `${response.status} ${(await response.text()).slice(0, 200)}` };
  return { result: await response.json() };
}

/**
 * `sumibako brief [--project <name>] [--limit <n>]`, and `--hook <agent>` when
 * a SessionStart hook runs it. As a hook it reads the payload on stdin,
 * answers only a session that is starting fresh (not one resumed or
 * compacted, which still has its context), prints the reply both Claude Code
 * and Codex read (`hookSpecificOutput.additionalContext`), and exits 0 with
 * nothing printed whenever it has nothing worth saying.
 */
async function brief(flags) {
  const agent = typeof flags.hook === "string" ? flags.hook : null;
  if (!agent) {
    const project =
      typeof flags.project === "string" && flags.project.trim()
        ? flags.project.trim()
        : projectOf(process.cwd());
    if (!project) die("This folder is not in a repository.", "Pass --project owner/name.");
    const limit = typeof flags.limit === "string" ? Number(flags.limit) : undefined;
    const result = await callApi("GET", "/v1/pages/brief", {
      retry: true,
      query: { project, limit },
    });
    console.log(renderBrief(result) || dim(`No pages in ${project} yet.`));
    return;
  }

  // The agent the hook was installed for, whatever the shell says.
  runningAgent = agent;
  try {
    let input = {};
    try {
      const raw = await readStdin(1000);
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      input = {};
    }
    // A fresh session, or one cleared: those are the ones with nothing in mind.
    if (input.source && input.source !== "startup" && input.source !== "clear") return;
    const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
    const project =
      typeof flags.project === "string" && flags.project.trim()
        ? flags.project.trim()
        : projectOf(cwd);
    if (!project) return;

    let text = "";
    const cacheFile = briefCacheFile(project);
    try {
      const { result, error } = await fetchBrief(project, undefined, BRIEF_WAIT_MS);
      if (result) {
        text = renderBrief(result);
        fs.mkdirSync(BRIEF_CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), text }));
      } else {
        logHook(`brief ${agent}: ${error}`);
      }
    } catch (error) {
      logHook(`brief ${agent}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!text) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (cached.text && Date.now() - cached.at < BRIEF_CACHE_DAYS * 24 * 60 * 60 * 1000) {
          text = `${cached.text}\n(As of ${dateOnly(cached.at)}; the vault did not answer in time.)`;
        }
      } catch {
        // No copy either: say nothing.
      }
    }
    if (!text) return;
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
      })}\n`,
    );
  } catch (error) {
    logHook(`brief ${agent}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    process.exitCode = 0;
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const HELP = `
${bold("sumibako")} - file what your coding agent wrote into your vault

  ${bold("sumibako login")} [--token <t>] [--api <url>]  connect this machine
  ${bold("sumibako init")} [--yes | --undo]            set up Claude Code, Codex and Cursor here
  ${bold("sumibako publish")} <file.md> [--public]  file a Markdown file as a page
  ${bold("sumibako unpublish")} <file.md>           take a published page off the web
  ${bold("sumibako append")} <file.md> <text>       add to the end of a page
  ${bold("sumibako attach")} <file.md> <file...>    add images, PDFs and other files to a page
  ${bold("sumibako edit")} <file.md> --find ...     replace one piece of text
  ${bold("sumibako open")} <file.md> [--markdown]   print the links, or the page
  ${bold("sumibako search")} [words]                search your vault, or list it
  ${bold("sumibako brief")} [--project <name>]      this project's recent pages, one line each
  ${bold("sumibako whoami")}                        check the token and plan
  ${bold("sumibako logout")}                        forget the token

${bold("Options for publish")}
  --public            publish it and print a shareable link
  --passcode          publish it behind a passcode, printed with the link
  --new-passcode      replace the passcode; the old one stops working
  --anyone            let anyone with the link open it, removing a passcode
  --expires <when>    7d, 30d or never: how long the link works, from now
  --title <title>     override the title (default: the first heading)
  --icon <emoji>      the page's icon, one emoji (default: guessed from the title)
  --cover <name>      the banner across the top (default: picked from the title)
  --key <key>         the identity of this artifact (default: its repo path)
  --project <name>    the project it belongs to (default: the repository)
  --new               file a new page even if this file was filed before
  --parent <page-id>  nest it under an existing page
  --agent <name>      which agent is writing (default: worked out from the
                      shell; claude-code, codex, cursor, gemini, ...)

${bold("Options for append, attach and edit")}
  --prepend           add to the start of the page instead of the end
  --find <text>       the exact text to replace, as open --markdown prints it
  --replace <text>    what to put there; empty deletes the matched text
  --title <title>     rename the page
  --icon <emoji>      set the page's icon
  --cover <name>      set the page's banner
  --key <key>         name the page by its key rather than a path or an id
  --project <name>    the project the key is filed under (default: the repository)

${bold("Projects")}
  Pages are filed by project: the repository a file is in, by its remote's
  owner/name. Each project's pages go in a folder of their own under Agent
  notes, and the same path in two repositories is two pages.

${bold("Covers")}
  A new page gets a banner across its top, picked from its title. Name one
  with --cover, or with a cover: line in the file's frontmatter:
    ${COVERS.slice(0, 8).join(", ")},
    ${COVERS.slice(8).join(", ")}
  --cover none files a page without one. A page that exists keeps the cover
  it has until you pass --cover, and a picture uploaded in the app is never
  replaced from here.

${bold("Images and files")}
  A line like ![](./shot.png) in the Markdown you publish, append or put in
  with edit is uploaded and shown on the page: images, video, audio and PDF,
  from inside the repository the Markdown is in. Anything else is left as
  written and the command says so.

  attach adds files you name to a page that exists, of any type and from
  anywhere: sumibako attach docs/plan.md report.pdf demo.mp4

  A file already in the vault is not uploaded again, so re-running is cheap.

${bold("Editing a page you did not write")}
  open --markdown prints the page as Markdown, which is the same text --find
  matches against. A --find that appears twice is refused rather than guessed
  at, so quote enough of the surrounding lines to be unambiguous.

${bold("How re-running works")}
  A file is filed under its path in the repo, so publishing the same file again
  updates the same page instead of making a second one. Pass --new when you
  genuinely want another page, or --key to choose the identity yourself.

${bold("Passcodes")}
  --passcode puts the page behind six characters, printed under the link. The
  link alone opens a lock screen. Publishing again, with or without --public,
  keeps the passcode and the link; only --anyone takes it off. open prints the
  passcode again whenever it is needed.

${bold("Links that expire")}
  --expires 7d or 30d makes the link stop working that long from now; the
  page then goes private by itself. Publishing again keeps the date and never
  extends it. A page whose link ran out stays private: publishing it again
  files the changes and leaves it down until you pass --expires again.

${bold("Setting up your agents")}
  init finds Claude Code, Codex and Cursor on this machine and, with a yes
  for each, gives every one the skill and the MCP server, and Claude Code and
  Codex a hook that files each plan into your vault as a private page: the
  plan you approve in Claude Code, the plan Codex proposes; and a hook that
  starts each new session with this project's recent pages (brief). --yes says yes to
  all of it, --dry-run only lists it, and --undo takes it all back out,
  putting each file back exactly as it was if nothing has changed it since.
  A hook never publishes, never stops the agent, and logs to ~/.sumibako/hook.log.

${bold("Connecting")}
  Any command will start it: with no token, it prints a link to open and exits
  with code 3. Open the link, approve it, run the same command again. Nothing
  is typed and nothing waits, so an agent can do this without stalling.

  Exit codes: 0 worked, 3 not connected yet, 1 everything else.

${bold("Environment")}
  SUMIBAKO_TOKEN      use this token instead of the saved one
  SUMIBAKO_API        point at a different deployment
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);
  runningAgent = detectAgent(process.env, flags.agent);

  if (!command || command === "help" || flags.help === true) {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "version") {
    console.log(version());
    return;
  }

  switch (command) {
    case "login":
      return login(flags);
    case "logout":
      return logout();
    case "publish":
    case "push":
      return publish(positional, flags);
    case "unpublish":
      return unpublish(positional, flags);
    case "append":
      return append(positional, flags);
    case "attach":
      return attach(positional, flags);
    case "edit":
      return edit(positional, flags);
    case "open":
    case "get":
      return open(positional, flags);
    case "search":
    case "list":
      return search(positional);
    case "whoami":
      return whoami();
    case "init":
      return init(flags);
    case "hook":
      return hook(positional);
    case "brief":
      return brief(flags);
    default:
      die(`Unknown command: ${command}`, "Run `sumibako help` for the list.");
  }
}

/*
  Run, unless something imported this file to check a part of it.

  `npm run verify` in the repository this ships from holds the embed scanner:
  what it will take off a disk and what it leaves alone is the kind of rule
  that is wrong silently. It sets this variable and imports the functions
  below. The test is "is the variable set" rather than "was this file the
  entry point", because the second has to be worked out from paths that
  differ under npx, a symlinked bin and a Windows shim, and a wrong guess
  there is a command that does nothing for everybody.
*/
if (!process.env.SUMIBAKO_AS_MODULE) {
  main().catch((error) => {
    die(error instanceof Error ? error.message : String(error));
  });
}

export {
  briefCommand,
  claudePlanFrom,
  codexPlanFrom,
  COVERS,
  detectAgent,
  findEmbeds,
  hookCommand,
  hostedEmbed,
  locateEmbed,
  mcpUrlFor,
  projectFromRemote,
  renderBrief,
  withCodexMcp,
  withCursorMcp,
  withHook,
  withoutCodexMcp,
  withoutCursorMcp,
  withoutHooks,
};
