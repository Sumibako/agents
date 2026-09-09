# Sumibako for coding agents

Lets Claude Code, Codex, Cursor, Copilot and anything else that reads
[Agent Skills](https://agentskills.io) file the documents they write into your
[Sumibako](https://sumibako.com) vault, and hand you back a link you can send
to someone.

```bash
npx skills add sumibako/agents
```

That copies one Markdown file into your agent's skills directory. It runs no
code and asks for no credentials.

## Then what

Ask your agent for something it would write down anyway.

> Write up the migration plan and give me a link I can send the team.

The first time, the command it runs prints a link. Open it, check the code
matches, approve. Your agent runs the command again and hands you the link.
There is no token to create and nothing to paste.

## What it can and cannot do

It can write pages, read them back, change part of one without rewriting the
rest, search your vault, and publish a page to a shareable link or take it back
down.

It **cannot delete anything** - there is no delete in the API at all - and it
cannot make a page findable by a search engine or reach any other account.
Published pages carry `noindex` until you decide otherwise yourself, in the
app, one page at a time.

You can revoke a machine's access at any time in Settings, under Coding agents.

## Without the skill

The skill is instructions, not the tool. The tool is
[`npx sumibako`](https://www.npmjs.com/package/sumibako), which works on its
own, and there is an MCP server for agents with no terminal. Both are covered
at [sumibako.com/agents](https://sumibako.com/agents).

## Source

The skill is generated from `cli/SKILL.md` in the Sumibako repository, so it
cannot drift from the CLI it describes. Corrections are welcome here and will
be carried back.
