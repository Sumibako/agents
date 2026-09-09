# sumibako

File the plans, specs and notes your coding agent writes into your
[Sumibako](https://sumibako.com) vault, and get a link you can send to someone.

```bash
npx sumibako login
npx sumibako publish docs/plans/auth-rewrite.md --public
```

```
Created Auth rewrite plan
https://sumibako.com/vault/Auth-rewrite-plan-jd76...

Share this: https://sumibako.com/p/Auth-rewrite-plan-jd76...
```

## Why

Coding agents write a lot of prose that is worth keeping: implementation plans,
specs, architecture decisions, migration checklists, handoff notes. It ends up
as untracked Markdown in a working directory, or pasted into a chat, and then
somebody asks "can you send me that plan" and there is nothing to send.

Each agent has its own answer to this, and each answer only covers that agent's
own output and lives on that vendor's domain. This is one place for all of them,
in a vault you already own, where the document is a page you can keep editing.

## Setup

There isn't one. Run a command, and if this machine is not connected it prints
a link instead of doing the work:

```bash
npx sumibako publish docs/plans/auth-rewrite.md --public
```

```
Connect this machine to Sumibako:
https://sumibako.com/connect?code=WXYZ-4821
```

Open it, check the code matches, approve. Then run the same command again and
it carries on. `npx sumibako login` does the same thing and waits, if you would
rather connect first.

Nothing is typed and nothing blocks, which is what lets a coding agent do this
on your behalf: it relays the link, you click, it runs the command again. The
token is stored in `~/.sumibako/config.json` with owner-only permissions.

Two ways round it when a browser is not in the picture. `--token <token>` takes
one you minted yourself under **Settings, Coding agents**, and `SUMIBAKO_TOKEN`
in the environment overrides everything, which is what CI should use.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | It worked |
| `3` | Not connected yet; a link was printed |
| `1` | Anything else |

## Commands

| Command | What it does |
| --- | --- |
| `sumibako login` | Connect this machine, waiting for you to approve it |
| `sumibako publish <file.md>` | File a Markdown file as a page |
| `sumibako publish <file.md> --public` | And put it on the web, printing the link |
| `sumibako unpublish <file.md>` | Take the page off the web |
| `sumibako append <file.md> "text"` | Add to the end of a page |
| `sumibako edit <file.md> --find ... --replace ...` | Replace one exact piece of text |
| `sumibako open <file.md>` | Print the links for a page (`--markdown` for the page) |
| `sumibako search [words]` | Search your vault, or list it with no words |
| `sumibako whoami` | Check the token, plan and usage |
| `sumibako logout` | Forget the token on this machine |

### Options for `publish`

| Option | Meaning |
| --- | --- |
| `--public` | Publish it and print a shareable link |
| `--title <title>` | Override the title, which otherwise comes from the first heading |
| `--key <key>` | Set the artifact's identity yourself |
| `--new` | File a new page even if this file was filed before |
| `--parent <page-id>` | Nest it under an existing page |

### Options for `append` and `edit`

| Option | Meaning |
| --- | --- |
| `--prepend` | Add to the start of the page instead of the end |
| `--find <text>` | The exact text to replace, as `open --markdown` prints it |
| `--replace <text>` | What to put there; an empty string deletes the matched text |
| `--title <title>` | Rename the page |
| `--key <key>` | Name the page by its key rather than by a path or an id |

## Changing a page without re-sending it

`publish` replaces the whole page. When you only want to add a line, or fix a
sentence in a page you no longer have on disk, read it and change that part:

```bash
sumibako open docs/plans/auth.md --markdown
sumibako append docs/decisions.md "- chose Postgres over Dynamo"
sumibako edit docs/plans/auth.md --find "ship in Q3" --replace "ship in Q4"
```

`--find` matches against the Markdown `open --markdown` prints, and has to
match exactly once. If it appears twice the command refuses rather than picking
one, because picking one is how the wrong paragraph gets rewritten and nobody
finds out. Quote more of the surrounding lines.

The page's previous version is kept for fourteen days either way, and **Version
history** in the document menu puts it back.

## Publishing the same file twice

A file is filed under its path in the repository, so running `publish` again
updates the same page rather than making another one. That is the behaviour you
want when an agent revises a plan five times in a session: one page, one link,
always current.

Pass `--new` when you really do want a second page, or `--key` to choose the
identity yourself (useful when the file moves but the artifact does not).

## What survives the conversion

Headings, paragraphs, bold, italic, strikethrough, inline code, links, bullet
lists, numbered lists, task lists, nested lists, blockquotes, GitHub alerts
(`> [!NOTE]`), tables, fenced code with syntax highlighting, images on their own
line, and horizontal rules.

Two things degrade, and the command says so when they do:

- **Mermaid** renders as a plain code block. There is no diagram renderer.
- **Raw HTML** is kept as text.

## Privacy

Pages are private until you pass `--public`. A published page has a link anyone
can open, and carries `noindex` so search engines do not list it. Making a page
findable in search is a separate opt-in that only you can give, per page, in the
app - a token cannot do it.

## For agents

`SKILL.md` in this package is written for a coding agent to read. Point Claude
Code, Codex or Cursor at it and they will use the CLI correctly, including the
part about not creating duplicates.

## If your agent has no shell

Claude.ai and ChatGPT cannot run this. They can reach an MCP server, so there is
one at `https://sumibako.com/api/mcp` offering the same things as tools:
`write_page`, `read_page`, `edit_page`, `search_pages`, `publish_page` and
`get_account`. Add it as an MCP server and send the same token as an
`Authorization: Bearer` header.

Prefer the CLI where a shell exists. An MCP tool call carries the whole document
through the model's context to get there, so a 30KB plan costs 30KB of tokens;
this reads the file off disk and the model never holds it.

## Environment

| Variable | Meaning |
| --- | --- |
| `SUMIBAKO_TOKEN` | Use this token instead of the saved one |
| `SUMIBAKO_API` | Point at a different deployment |
| `NO_COLOR` | Turn off colour |
