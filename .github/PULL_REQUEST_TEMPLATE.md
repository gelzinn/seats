## Description

Closes #

## User-facing changes

<!-- For feat/fix/perf/revert/deps or breaking changes, replace the example
with a concise benefit or correction users will notice. Match the type of
the PR title. Release Please uses this block for the published notes.
For routine docs/chore/test/ci changes, remove the block and write None. -->

BEGIN_COMMIT_OVERRIDE
feat(scope): replace with a concrete change users will notice
END_COMMIT_OVERRIDE

## Type of change

- [ ] Bug fix
- [ ] New provider
- [ ] New feature
- [ ] Docs / metadata

## Checklist

- [ ] `bun run check` passes (Biome lint and format, typecheck, tests)
- [ ] `bun src/cli.ts help` runs without errors
- [ ] Changes to seat folders were tried with `--dry-run` or a throwaway `HOME`
- [ ] A new provider (if added) lives in `src/providers/<id>/` and is listed in `src/providers/index.ts`
