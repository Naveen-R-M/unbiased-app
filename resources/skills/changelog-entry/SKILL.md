---
name: changelog-entry
description: Write a CHANGELOG.md entry for this app in its house style. Use when the user asks for release notes, a changelog entry, or is preparing a version bump.
---

# Changelog entry

`CHANGELOG.md` is not a developer log. It is shipped twice — the app renders it
in Settings → Updates, and the release workflow slices the section for the tag
and publishes it as the release body. So it is read by the person using the
app, not the person who wrote the code.

## Format, exactly

```
## <version> — <Month D, YYYY>

### New          (or Improved, or Fixed)

- One sentence saying what changed for the reader.
```

The heading is matched literally by the release workflow (`## <version> — `),
so the em dash and the spacing are load-bearing. A mismatch fails the release.

## How to write the bullets

- **Say what the person can now do, or what stopped going wrong.** Not what
  moved in the code.
- **Name the symptom they saw.** "Every call came back as 'user rejected MCP
  tool call' — a refusal you were never asked about" beats "fixed elicitation
  response shape".
- **One bullet per user-visible change.** Two internal commits that fix one
  symptom are one bullet.
- **No issue numbers, file paths, function names, or component names.**
- **Prefix a security-relevant fix with `Security:`** — the existing entries do.
- **Skip it entirely** if a change is invisible to the reader. Refactors and
  test-only work do not get a bullet.

## Before finishing

Check the version in the heading matches `package.json`. The release workflow
refuses a tag that disagrees with it, and that failure happens after the build.
