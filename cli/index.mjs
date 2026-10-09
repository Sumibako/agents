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

import { spawn } from "node:child_process";
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
async function rawCall(
  method,
  base,
  endpoint,
  { body, query, token, tolerateNetworkError = false } = {},
) {
  const url = new URL(base + endpoint);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
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

async function callApi(method, endpoint, { body, token, query, api } = {}) {
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
// Arguments
// ---------------------------------------------------------------------------

/**
 * Flags that never take a value.
 *
 * Without this list `--public plan.md` read the file name as the flag's value
 * and then asked "Which file?", because nothing distinguishes a switch from an
 * option that happens to be followed by a word. An agent puts flags wherever
 * it likes, so these never swallow the argument after them.
 */
const SWITCHES = new Set([
  "public",
  "publish",
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
    const who = await callApi("GET", "/v1/whoami", { token, api });
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

async function publish(positional, flags) {
  const file = positional[0];
  if (!file) {
    die("Which file?", "Usage: sumibako publish <file.md> [--public]");
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

  const wantsPublic = flags.public === true || flags.publish === true;

  const result = await callApi("POST", "/v1/pages", {
    body: {
      markdown,
      externalId: key,
      title: typeof flags.title === "string" ? flags.title : undefined,
      // One emoji. Also read from an `icon:` frontmatter line by the server,
      // which is the way to make it travel with the file; the flag wins.
      icon: typeof flags.icon === "string" ? flags.icon : undefined,
      // A banner's name, or "none". The same two ways in as the icon: this
      // flag, or a `cover:` line in the frontmatter, and the flag wins.
      cover: coverFlag(flags),
      parentDocument: typeof flags.parent === "string" ? flags.parent : undefined,
      publish: wantsPublic ? true : undefined,
    },
  });

  report(result, { verb: result.created ? "Created" : "Updated", notes });
}

/**
 * Works out whether an argument names a file on disk or a page id.
 *
 * A file that exists is keyed by its repo path, the same way `publish` filed
 * it. Anything else is taken to be a page id, which is what someone pastes
 * after copying it out of a URL.
 */
function targetFor(argument, flags) {
  if (typeof flags.key === "string") return { externalId: flags.key };
  if (!argument) return {};
  if (fs.existsSync(argument)) return { externalId: defaultKey(argument) };
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
    query: { id: target.documentId, externalId: target.externalId },
  });
  console.log(titled(page));
  console.log(page.url);
  if (page.publicUrl) console.log(green(page.publicUrl));

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
    query: { q: term || undefined, limit: term ? undefined : 20 },
  });

  if (results.length === 0) {
    console.log(dim(term ? "Nothing matched." : "This vault has no pages yet."));
    return;
  }
  for (const page of results) {
    console.log(`${titled(page)}${page.publicUrl ? green("  public") : ""}`);
    console.log(dim(`  ${page.publicUrl ?? page.url}`));
  }
}

async function whoami() {
  const who = await callApi("GET", "/v1/whoami");
  const usage = await callApi("GET", "/v1/usage");
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
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const HELP = `
${bold("sumibako")} - file what your coding agent wrote into your vault

  ${bold("sumibako login")} [--token <t>] [--api <url>]  connect this machine
  ${bold("sumibako publish")} <file.md> [--public]  file a Markdown file as a page
  ${bold("sumibako unpublish")} <file.md>           take a published page off the web
  ${bold("sumibako append")} <file.md> <text>       add to the end of a page
  ${bold("sumibako attach")} <file.md> <file...>    add images, PDFs and other files to a page
  ${bold("sumibako edit")} <file.md> --find ...     replace one piece of text
  ${bold("sumibako open")} <file.md> [--markdown]   print the links, or the page
  ${bold("sumibako search")} [words]                search your vault, or list it
  ${bold("sumibako whoami")}                        check the token and plan
  ${bold("sumibako logout")}                        forget the token

${bold("Options for publish")}
  --public            publish it and print a shareable link
  --title <title>     override the title (default: the first heading)
  --icon <emoji>      the page's icon, one emoji (default: guessed from the title)
  --cover <name>      the banner across the top (default: picked from the title)
  --key <key>         the identity of this artifact (default: its repo path)
  --new               file a new page even if this file was filed before
  --parent <page-id>  nest it under an existing page

${bold("Options for append, attach and edit")}
  --prepend           add to the start of the page instead of the end
  --find <text>       the exact text to replace, as open --markdown prints it
  --replace <text>    what to put there; empty deletes the matched text
  --title <title>     rename the page
  --icon <emoji>      set the page's icon
  --cover <name>      set the page's banner
  --key <key>         name the page by its key rather than a path or an id

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

export { COVERS, findEmbeds, hostedEmbed, locateEmbed };
