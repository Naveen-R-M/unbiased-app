# The tree can describe the past

Reads through the accessibility layer can report state from *before* your last
action. This is not rare and it is not a bug you can wait out reliably.

Measured against Chrome on macOS, 2026-09-16:

- **A value lags one update.** A text area overwritten while it already held
  text read back as its PREVIOUS value for hundreds of milliseconds, then
  showed the new one after some later, unrelated operation.
- **A whole document persists.** After a tab navigated away, a full read still
  returned the previous page — every field, with values — while the address bar
  correctly showed the new URL.
- **A stepper's value appears a step late.** Three arrow keys read as
  `"" → "1" → "2"`: the first press was invisible at the time and present
  afterwards.

## What follows

- **A read taken immediately after an action may describe the state before it.**
  If what you read disagrees with what you just did, read again before
  concluding the action failed.
- **Do not build a conclusion on one read.** Especially not "it did nothing" —
  that is the conclusion staleness produces.
- **Prefer a structural change as evidence.** Whether a panel opened is far
  more reliable than whether a value updated.
- **Check something outside the tree when it matters.** An address bar, a
  status line, a rendered result. These come from the app rather than from the
  accessibility layer and do not share its lag.
