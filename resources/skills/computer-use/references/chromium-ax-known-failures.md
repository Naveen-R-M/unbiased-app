# Measured failures

Specific, dated, and narrow on purpose. Treat them as examples of the general
rule — *advertised capability is not proof* — rather than as the whole list.
Anything not measured here is unknown, not safe.

**Measured 2026-09-16 against Google Chrome on macOS 26. Not verified against
native AppKit controls, other browsers, or other Chrome versions.**

| what | behaviour |
| --- | --- |
| `set_value` on a text field / text area | works |
| `set_value("")` on any text control | accepted, **ignored** — the field keeps its value |
| `set_value` on a pop-up button (native `<select>`) | accepted, **ignored** |
| `set_value` on an incrementor (`<input type=number>`, date sub-fields) | accepted, **ignored** |
| `increment` / `decrement` on an incrementor | advertised, returns `ok`, **value does not move** |
| `AXUIElementIsAttributeSettable` on all of the above | reports `true` — **it does not predict whether the write lands** |
| typing into a field that already holds text | **appends**; select first to replace |
| `show menu` on a pop-up button in a page | opens the BROWSER's context menu, not the control's options |
| arrow keys on a stepper | works |
| typing into a date sub-field | works |
| reading a value straight after writing it | may return the **previous** value |
| reading a page straight after navigating | may return the **previous document**, entire |

## The part that generalises

Three separate routes returned `ok` and did nothing: value writes to two
control families, `increment`, and empty-string writes. In each case the only
thing that exposed it was evidence from outside the accessibility layer — the
page's own rendered output, or a value that visibly failed to move.

So: when a write matters, get evidence the app produced. When you cannot, say
the result is unverified. Do not let an `ok` stand in for it.
