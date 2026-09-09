---
name: sumibako
description: File a plan, spec, ADR, handoff note or research report into the user's Sumibako vault and get back a link they can send to someone. Use when the user asks to save, file, publish or share a document you wrote, or asks for "a link to this", or says a teammate needs to read it. Also use to read, amend or take down a page already in the vault, and to search what is there before writing something new.
license: MIT
compatibility: Requires Node 18+ and network access to sumibako.com
allowed-tools: Bash(npx sumibako search:*) Bash(npx sumibako open:*) Bash(npx sumibako whoami)
metadata:
  author: sumibako
  version: "0.2.1"
---

<!--
  `allowed-tools` covers the three commands that only read.

  Deliberately not `publish`, `edit`, `append` or `unpublish`. Publishing puts a
  document on the open web and the rest change what is in somebody's vault, and
  a skill that pre-approved those would be using this field to talk its way past
  the confirmation a person actually wants. Looking things up is the part where
  a prompt is pure friction, so that is the part this covers.
-->


# Filing documents in Sumibako

Sumibako is the user's notes vault. This skill puts a Markdown document you
wrote into it and, on request, gives you a public link to hand back.

## When to use this

Reach for it when a document you produced needs to outlive the session or be
read by somebody who is not in it:

- The user says "save this", "file this", "put this in my notes", "publish
  this", "give me a link", "send this to my team", "I need to share this".
- You finished a plan, spec, design, ADR, migration checklist, incident
  write-up, research summary or handoff note, and the user wants to keep it.
- You are picking up work and want to know what is already written down:
  `sumibako search`, or `sumibako search` with no words to see the vault.
- The user wants something already filed changed: a section added to a running
  log, a decision corrected, a page taken back off the web.

Do **not** use it for things that belong in the repository. Code, tests,
configuration and specs that are reviewed alongside a diff go in the repo and
through a pull request. This is for the documents whose audience is a person,
not a compiler, and often a person who will never open the repo.

## Connecting, the first time

**There is no setup step to do in advance, and nothing for the user to paste.**
Run the command you were going to run. If this machine is not connected yet,
the command prints a link and stops with **exit code 3** without doing any
work:

```
Connect this machine to Sumibako:
https://sumibako.com/connect?code=WXYZ-4821

It should show the code WXYZ-4821. If it does not, the
page belongs to a different request - close it.

Then run the same command again.
```

When you see exit code 3:

1. **Give the user the link exactly as printed**, along with the code, and ask
   them to open it and approve the request. Do not shorten it, do not describe
   it, do not put it behind other text.
2. **Do not wait, poll, or retry in a loop.** Finish your turn. Nothing is
   pending on your side.
3. **When the user says they have approved it, run the same command again.** It
   collects the token and carries on with the original job in one step. You do
   not need to run `login` separately.

Nothing else about this is yours to handle:

- **Never ask the user for a token**, and never offer to take one in chat. A
  token pasted into a conversation is a credential in a transcript.
- **Never run `npx sumibako login` on your own.** It waits for a person, which
  is the one thing your shell cannot do. The flow above exists so you do not
  have to.
- **Exit code 3 is not a failure.** It means "not connected yet". Any other
  non-zero code is a real error and worth reading.

If the user would rather paste a token they already have, `npx sumibako login
--token <token>` takes one, and CI sets `SUMIBAKO_TOKEN` in the environment and
skips all of this.

## Filing a document

Write the Markdown to a file first, then publish the file. Do not pipe a
document through the command line.

```bash
npx sumibako publish docs/plans/auth-rewrite.md
```

To get a link the user can send to someone:

```bash
npx sumibako publish docs/plans/auth-rewrite.md --public
```

The command prints the page's link, and the public link when there is one.
Give the user the public link verbatim. Do not paraphrase or shorten it.

### Before you pass `--public`

`--public` puts the document on the open web. Anyone with the link can read it
without signing in. It is not indexed by search engines, and that is the only
protection it has.

So do two things first, both briefly:

1. **Read what you are about to publish** and check it carries no credentials,
   customer data or anything else that should not leave the repository. If you
   find something, say so and stop; do not publish it and ask afterwards.
2. **Say in one line what will become readable**, then publish.

Keep this to a sentence. It is a check, not a report - narrating the audit at
length is worse than not doing it, because the user stops reading and the one
time it matters gets skipped with everything else.

If you are unsure whether the user wants it on the web, publish privately
first. `publish` without `--public` files the page and nothing leaves the
account, and `--public` afterwards is one more command.

### The permission prompt is not an error

Publishing reaches the internet, so an agent harness may well stop and ask the
user before the command runs. That is the harness doing its job, and it happens
before Sumibako sees anything.

When it happens:

- **Do not retry the command in a loop**, and do not reach for a different tool.
  Nothing failed.
- **Do not tell the user that publishing was blocked or that something went
  wrong.** Tell them the command is waiting for their approval, and what it will
  publish.
- If they approve, run it once. If they decline, leave it and say the document
  is still local.

## The one rule that matters

**A file is filed under its path in the repository, so publishing the same file
again updates the same page.** Run it after every revision. You will not create
duplicates, and the user's link keeps working and keeps showing the current
version.

Only pass `--new` when the user genuinely wants a second, separate page - a new
incident, a different feature. Reaching for it out of caution is how a vault
fills up with eleven copies of one plan.

## Changing a page instead of replacing it

`publish` replaces the whole page, which is right when you still hold the file.
When you do not - the page was written in the app, or in a session that has
ended - read it and change the part that is wrong:

```bash
npx sumibako open docs/plans/auth.md --markdown   # the page, as Markdown
```

That Markdown is the page. Add to it, or replace an exact piece of it:

```bash
# add a line to the end, without sending the rest back
npx sumibako append docs/decisions.md "- 2026-09-06: chose Postgres over Dynamo"

# correct one sentence
npx sumibako edit docs/plans/auth.md \
  --find "We will ship this in Q3." \
  --replace "We will ship this in Q4, after the migration."

# rename
npx sumibako edit docs/plans/auth.md --title "Auth rewrite, revised"
```

**`--find` must match exactly once.** It is matched against the Markdown that
`open --markdown` prints, not against the words as they look in the app, so
read the page first and paste from what you read. If it appears twice the
command refuses rather than guessing - quote more of the surrounding lines and
try again. Do not work around this by replacing the whole page unless the user
asked for a rewrite.

Prefer `append` over reading and re-publishing a page you are only adding to.
It sends one line instead of the whole document and cannot disturb the rest.

## The rest of the commands

```bash
npx sumibako search "auth rewrite"       # what is already written down
npx sumibako search                      # or list the newest pages
npx sumibako open docs/plans/auth.md     # the links for a page
npx sumibako open docs/plans/auth.md --markdown   # and the page itself
npx sumibako unpublish docs/plans/auth.md     # take the link off the web
```

## Writing for it

The document is rendered as a real page, so ordinary Markdown pays off:

- **The first heading becomes the page title.** Start with one `#` line saying
  what the document is. Or put `title:` in YAML frontmatter.
- Headings, lists, task lists, tables, blockquotes, links and fenced code all
  render properly. Tables are worth using for options and trade-offs.
- Code fences keep their language and get syntax highlighting.
- `> [!NOTE]` and `> [!WARNING]` become a bold label on the quote.

Two things degrade, and the command tells you when they do:

- **Mermaid diagrams** render as plain code, not pictures. A short prose
  description alongside the diagram is worth adding.
- **Raw HTML** is kept as text.

## What it will not do

- It cannot delete a page. The user does that in the app. `unpublish` takes the
  link off the web and leaves the writing alone.
- It cannot make a page findable by search engines. Published pages carry
  `noindex`; the user turns that on themselves if they want it, per page.
- It cannot read or write anyone else's vault.

## Errors worth reading

- `400` - the request was wrong, and the message says how. From an edit this
  is usually a `--find` that matched nothing or matched twice. Read the page
  with `open --markdown` and quote it exactly.
- `401` - the token was revoked. The CLI forgets it, so running the same
  command again starts a fresh connect and prints a link. Relay that link.
- `403` - the token is not allowed to publish. The user can create one that is.
- `409` - the plan's page limit is reached. Report the message; it says which.
- `413` - the document is too long. Split it.
- `429` - too many requests. Wait the number of seconds it names.
