# Knowing whether an action actually worked

A tool returning `ok` means the API accepted the request. It does not mean the
app changed. Every silent failure measured so far returned `ok`.

## Sources, strongest first

**Strong — the app rendered something new.**
- A result, status or confirmation the app printed. A form that echoes what it
  saved is the best evidence there is: it comes from the app's own state, not
  from the accessibility layer.
- A panel, sheet, menu or row that appeared or disappeared — a structural
  change in the tree, not a value inside it.
- A screenshot of the region, when the change is visual.

**Weak — the accessibility layer's account of itself.**
- Reading the value back after writing it.
- `[selected]`, `[focused]` and other state flags.
- The tool returning success.

Weak sources share one failure: they come from the same layer that performed
the action, and when that layer is stale it is stale for all of them at once.
Two weak sources agreeing is still one source.

## What to do with each outcome

- **Confirmed** — a strong source shows the result you wanted. Move on.
- **Unverified** — only weak sources are available. Say so and continue. This
  is the normal outcome for a value written into a browser field, because no
  strong source exists for it. It is not a failure and it is not a reason to
  retry.
- **Contradicted** — a strong source shows the result did not happen. Change
  route; see `set-value-strategy.md`. Do not send the same thing again.

## Never retry a silent write to gain confidence

A write that was accepted and did nothing does nothing the second time, and the
third. The measured cost of that reflex is the largest single waste in these
tasks. If a write did not land, the route is wrong, not the number of attempts.
