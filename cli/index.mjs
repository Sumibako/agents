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

const VERSION = "0.2.0";

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
async function rawCall(method, base, endpoint, { body, query, token } = {}) {
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
    die(
      `Could not reach ${url.origin}.`,
      error instanceof Error ? error.message : undefined,
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
      die(message, "Create a token with publishing allowed, in Settings.");
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
*/

/** How long a redeem waits before giving the link back to the caller. */
const REDEEM_WAIT_MS = 20_000;

/** Gap between redeem attempts while waiting. */
const REDEEM_INTERVAL_MS = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens a URL in the desktop browser, and does not care if it cannot.
 *
 * Called only when stdout is a terminal. An agent, a container and a CI job all
 * fail that test, which is exactly right: there is no browser to open there,
 * and the URL is already printed for whoever can open one. That one condition
 * covers every headless case without a flag to remember.
 */
function openInBrowser(url) {
  try {
    const [command, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The link is on screen either way.
  }
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
    const { response, payload } = await rawCall("POST", base, "/v1/cli/redeem", {
      body: { userCode: pending.userCode, verifier: pending.verifier },
    });

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
  needsAuth(started.verificationUrl, started.userCode);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

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
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }

  return { flags, positional };
}

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
  let directory = path.dirname(absolute);

  for (let depth = 0; depth < 40; depth += 1) {
    if (fs.existsSync(path.join(directory, ".git"))) {
      return path.relative(directory, absolute).split(path.sep).join("/");
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return absolute.split(path.sep).join("/");
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

  if (process.stdout.isTTY) openInBrowser(pending.verificationUrl);

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

  const markdown = readMarkdown(file);
  if (!markdown.trim()) die(`${file} is empty.`);

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
      parentDocument: typeof flags.parent === "string" ? flags.parent : undefined,
      publish: wantsPublic ? true : undefined,
    },
  });

  report(result, { verb: result.created ? "Created" : "Updated" });
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
 */
async function append(positional, flags) {
  const target = targetFor(positional[0], flags);
  if (!target.documentId && !target.externalId) {
    die("Which page?", "Usage: sumibako append <file.md | page-id> \"text\"");
  }

  const inline = positional.slice(1).join(" ");
  const text = inline || fs.readFileSync(0, "utf8");
  if (!text.trim()) {
    die("Nothing to add.", "Pass the text as an argument or pipe it in.");
  }

  const result = await callApi("PATCH", "/v1/pages", {
    body: {
      ...target,
      [flags.prepend === true ? "prepend" : "append"]: text,
    },
  });
  report(result, {
    verb: flags.prepend === true ? "Prepended to" : "Appended to",
  });
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
  const find = typeof flags.find === "string" ? flags.find : undefined;
  if (find === undefined && rename === undefined) {
    die(
      "Nothing to change.",
      "Pass --find with --replace, or --title to rename the page.",
    );
  }
  // An empty --replace is a deletion, and has to survive the default below.
  const replace = typeof flags.replace === "string" ? flags.replace : "";

  const result = await callApi("PATCH", "/v1/pages", {
    body: {
      ...target,
      ...(find !== undefined ? { find, replace } : {}),
      ...(rename !== undefined ? { title: rename } : {}),
    },
  });
  report(result, { verb: "Edited" });
}

async function unpublish(positional, flags) {
  const target = targetFor(positional[0], flags);
  if (!target.documentId && !target.externalId) {
    die("Which page?", "Usage: sumibako unpublish <file.md | page-id>");
  }

  const result = await callApi("POST", "/v1/pages/publish", {
    body: { ...target, publish: false },
  });
  console.log(`${green("Taken down.")} ${bold(result.title)} is private again.`);
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
  console.log(bold(page.title));
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
    console.log(`${bold(page.title)}${page.publicUrl ? green("  public") : ""}`);
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

/** Prints the outcome of a write, link last so it is the easiest thing to copy. */
function report(result, { verb }) {
  console.log(`${green(verb)} ${bold(result.title)}`);
  for (const warning of result.warnings ?? []) {
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
  ${bold("sumibako edit")} <file.md> --find ...     replace one piece of text
  ${bold("sumibako open")} <file.md> [--markdown]   print the links, or the page
  ${bold("sumibako search")} [words]                search your vault, or list it
  ${bold("sumibako whoami")}                        check the token and plan
  ${bold("sumibako logout")}                        forget the token

${bold("Options for publish")}
  --public            publish it and print a shareable link
  --title <title>     override the title (default: the first heading)
  --key <key>         the identity of this artifact (default: its repo path)
  --new               file a new page even if this file was filed before
  --parent <page-id>  nest it under an existing page

${bold("Options for append and edit")}
  --prepend           add to the start of the page instead of the end
  --find <text>       the exact text to replace, as open --markdown prints it
  --replace <text>    what to put there; empty deletes the matched text
  --title <title>     rename the page
  --key <key>         name the page by its key rather than a path or an id

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
    console.log(VERSION);
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

main().catch((error) => {
  die(error instanceof Error ? error.message : String(error));
});
