# Working on Teahouse

Guidelines for AI agents (Claude Code and others) working in this repository.

## Decisions that need the maintainer

When a choice is the maintainer's to make (product direction, security trade-offs, anything
public or hard to undo), don't stop at a list of open questions. Give, for each one:

- a quick overview: what the choice is and what each option means in practice, in a few lines;
- a suggestion: the option you would pick and why.

Carry on with everything that doesn't depend on the answer.

## Before committing

- `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (`pnpm format` fixes formatting).
- Changes people who run Teahouse notice get an entry in `CHANGELOG.md` under the unreleased
  version, linking the issue.
- Commit titles name the issue they close, e.g. `Docker: add a HEALTHCHECK (#19)`.
