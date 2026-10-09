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

On your own computer the page opens by itself and the command waits 30 seconds
for you to approve it, so usually the first run just finishes the job. Set
`SUMIBAKO_NO_BROWSER=1` to turn that off. Over SSH, in CI or in a container it
never opens anything.

Nothing is typed and nothing blocks for long, which is what lets a coding agent
do this on your behalf: it relays the link, you click, it runs the command
again. The token is stored in `~/.sumibako/config.json` with owner-only
permissions.

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
| `sumibako attach <file.md> <file...>` | Add images, PDFs and other files to a page |
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
| `--icon <emoji>` | The page's icon, one emoji; without it a new page gets one guessed from its title. An `icon:` line in the file's frontmatter does the same |
| `--cover <name>` | The banner across the top of the page, by name, or `none`; without it a new page gets one picked from its title. A `cover:` line in the frontmatter does the same. `sumibako help` lists the names |
| `--key <key>` | Set the artifact's identity yourself |
| `--new` | File a new page even if this file was filed before |
| `--parent <page-id>` | Nest it under an existing page |

### Options for `append`, `attach` and `edit`

| Option | Meaning |
| --- | --- |
| `--prepend` | Add to the start of the page instead of the end |
| `--find <text>` | The exact text to replace, as `open --markdown` prints it |
| `--replace <text>` | What to put there; an empty string deletes the matched text |
| `--title <title>` | Rename the page |
| `--icon <emoji>` | Set the page's icon |
| `--cover <name>` | Set the page's banner, or take it off with `none`. A picture uploaded in the app is never replaced |
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

## Images and files

A page can hold pictures, video, audio and files, and there are two ways to
put one there.

**Embed it in the Markdown.** A line like this, in a file you `publish` or in
text you `append` or put in with `edit --replace`:

```markdown
![The login screen](./screenshots/login.png)
```

The file is uploaded and the page shows it. A path is relative to the Markdown
file, or to where you ran the command when the text came from the command
line. `![](./demo.mp4)` becomes a player and `![](./report.pdf)` a file to
download, the same way.

```
Uploaded login.png (212 KB)
Created Auth rewrite plan
```

An embed uploads images, video, audio and PDF, and only from inside the
repository the Markdown is in (or its own folder, when it is in no
repository). That is deliberate: an embed is acted on without anybody naming
the file, and the Markdown may not be yours. Anything else is left exactly as
written and the command says which, and why.

**Attach it.** For a page that already exists, and for any file at all:

```bash
sumibako attach docs/plans/auth.md report.pdf demo.mp4
sumibako attach --key docs/plans/auth.md ~/Downloads/budget.xlsx
```

Each file goes at the end of the page as a block of its own. A type the vault
has no block for goes on as a link.

**Nothing is uploaded twice.** A file your vault already holds is recognised
by its contents and not sent again, so publishing a revised plan does not
store its screenshots a second time.

Files count against your plan's storage, exactly as an upload in the app does.
One that does not fit is refused before anything is sent, and the page is not
written. A stored file has an address anyone holding it can open, whether or
not the page is published, so do not embed something you would not put in a
link.

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
(`> [!NOTE]`), tables, fenced code with syntax highlighting, horizontal rules,
and an image, video, audio clip or file embedded on a line of its own.

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
`Authorization: Bearer` header. It writes text; sending a file needs this CLI.

Prefer the CLI where a shell exists. An MCP tool call carries the whole document
through the model's context to get there, so a 30KB plan costs 30KB of tokens;
this reads the file off disk and the model never holds it.

## Environment

| Variable | Meaning |
| --- | --- |
| `SUMIBAKO_TOKEN` | Use this token instead of the saved one |
| `SUMIBAKO_API` | Point at a different deployment |
| `NO_COLOR` | Turn off colour |
