---
name: computer-use
description: How to drive the user's own macOS apps with the computer_ tools — what to believe about what a tool reports, reading the element tree, acting by id, choosing a route a control will actually honour, and working on apps that are on another Space. It is handed to you automatically with the result of your first computer_ call in a conversation — do not open this file yourself; reading it here and receiving it there costs a turn and puts it in context twice.
---

# Driving the user's apps

You are handed this with your first desktop call of a conversation, so read it
before you act rather than after something fails.

These tools operate the apps already open on the user's Mac, as text. An app is
a tree of elements, each with an id, and you act on ids. The screen stays where
the user left it: reading and acting work on a background app, on any Space,
and none of it needs the app in front.

Deeper detail lives in files beside this one, named where it is relevant. Read
one when you hit the thing it covers — not before.

## What to believe

**`ok` is not proof.** A tool returning success means the API accepted the
request. It does not mean the app changed. Writes that are accepted and
discarded, and actions that are advertised and inert, both return `ok` — every
silent failure measured so far did.

**A read can describe the past.** Reads through the accessibility layer can
report state from before your last action — a value lagging one update, and
after a navigation, an entire previous document. If what you read disagrees
with what you just did, read again before concluding it failed. That conclusion
is exactly what staleness manufactures. See `references/staleness.md`.

**Readable is not interactable.** The tree you read is exact. What you press
may not land — see `references/parked-windows.md`. Trust what you read and
change how you act.

**So: prefer evidence the app produced.** A printed result, a panel that
opened, a row that appeared. Those come from the app. A value you read back
comes from the same layer that just performed the write, and when that layer is
stale it is stale for both. Two weak signals agreeing is still one signal.
`references/verification.md` has the full ordering; the short version is that
when only weak evidence exists you say **unverified** and carry on. That is a
normal outcome, not a failure, and not a reason to retry.

**Never send a silent write again to gain confidence.** A write that was
accepted and did nothing does nothing the second time. If it did not land, the
route is wrong — not the number of attempts. This reflex is the single largest
measured waste in these tasks.

## The loop

**Read once, then act.** `computer_app_state` returns the tree. Every action
returns what changed, so do not follow an action with a read. Pressing a search
result returns the card it opened; pressing a tab returns that tab's contents.

**Batch what you already know.** `computer_do` runs several steps on one app in
one call. Use it as soon as the next few moves are certain: fill a field, send
Return, read.

A turn costs about fifteen seconds whatever it carries, so the unit of work is
the turn, not the action. Setting one shape's x, y, width, height and colour is
ONE call with five steps, not five calls. Measured on a drawing task: 372
actions arrived nearly one per turn and the run took 23 minutes, where the same
actions batched by shape would have been about 40 turns. Every step in a batch
also skips the wait for the app to react — only the last one waits — so a batch
of five is faster than five singles by more than the round trips alone.

Across every run measured, **85–95% of the wall clock is deciding, not doing.**
Batching is the one lever that moves that number.

`computer_do` takes up to **30 steps**, and a step can be anything the single
tools do: a key, a modified key, a value, a selection, a press, a read.

**Read again only when the ids you need are not in front of you**, or when an
action reports that nothing changed and you expected something. After a press,
a click or a batch the reply ends with `Inspector now:` — every settable
control with its id and current value — so the next field is already named; do
not search for it. To look while you work, put `{"do":"screenshot"}` inside the
batch: the picture comes back with the same result, and a separate screenshot
call is a whole turn spent looking.

**When several routes might work and you cannot tell which the app will
honour, send them as candidates.** `computer_do` takes `candidates` instead of
`steps`: alternative routes to one state, tried in order, stopping at the first
that changes the app. A route is a step or a short list, because the one that
works is often two moves.

```json
{"app": "Maps", "candidates": [
  {"do": "press", "id": 88},
  [{"do": "key", "key": "down"}, {"do": "key", "key": "return"}]
]}
```

Three guesses cost one turn instead of three. Read the diff afterwards: "it
changed something" is not "it worked". Use it only for things you would not
mind happening twice.

## Ids

Ids are stable per app until an element disappears, and they do not survive the
app rearranging itself.

- An id whose control the app rebuilt is re-found for you. If exactly one
  element still matches what that id described, the action lands on it and the
  reply gives you the new number.
- An id that matches nothing is refused and says to read again. An id that now
  matches SEVERAL is refused as ambiguous — reading again will not resolve
  that one; name the element you meant.
- An action the element does not list is refused before it is attempted, and
  the refusal names the actions it does list.

## When a press is accepted and nothing happens

Distinct from a write that is discarded: here the click itself never lands.
**Stage Manager** parks the windows of apps the user is not looking at into the
side strip, and a window shrunk to a thumbnail stops hit-testing its contents.
List rows, the buttons on a card and segmented tabs all go dead. Typing, posted
keys and menu bar items are unaffected, because none of those are hit-tested.
A read of such an app opens with a line saying so, and its windows read
`[PARKED]`.

**Do not press it again, and do not raise the app.** Raising un-parks the
window only while that app is in front, and it re-parks the moment focus moves
on — measured, eleven seconds later the next press was dead again.

The route that works: say the whole intent in the app's search field, commit
with `down` then `return`, and otherwise use the **menu bar**, whose items are
in the tree and reach every command the app has. Send all three as `candidates`
in one call. `references/parked-windows.md` has the worked example and the
things that look like fixes and are not.

## Setting a value

A control's line tells you what it is and what it claims to support — the role,
and the actions in braces:

    32  incrementor "Seats" {press,increment,decrement}
    21  text field "Last name" = Kumar {press,show menu}

Use that to choose a first route, and then hold two things loosely:

**What a control advertises is not what it honours.** Roles and action lists
say what an element is *for*. Whether a given app implements it is a separate
question, and the answer differs between apps, between frameworks, and between
versions of the same app. Treat the advertised route as the first thing to
try, never as a guarantee.

**So set a value in three steps, not one.**

1. **Try the direct route.** `set_value` on anything that holds text. The
   action a control names for itself — `increment` on a stepper, `show menu`
   on something that opens — where that is what you want.
2. **Check whether it took.** Evidence the app produced beats a value read
   back; see `references/verification.md`.
3. **If it did not take, change route — do not repeat it.** The general
   fallback is to do what a person does: click into the control, select what is
   there, type the new value, commit. In one call:

```json
{"app": "<app>", "steps": [
  {"do": "pointer", "id": 84},
  {"do": "select_text", "id": 84},
  {"do": "type", "text": "12"},
  {"do": "key", "key": "return"}
]}
```

That sequence works on far more controls than any single write does, because
it goes through the same path a person's keystrokes take rather than through a
property nothing is obliged to implement.

**Select before you type.** Typing into a control that already holds text
appends to it: a `12` typed over a `12` becomes `1212`. `select_text` with no
`text` selects the whole value so the typing replaces it.

**Never open a replace with `command+a` then `delete` before clicking into the
field.** With focus outside a field those select every object in the document
and delete them — measured, it cleared a canvas mid-task. `select_text` is
scoped to the element you name and cannot reach past it.

**A composite control may be several elements.** A date, a time, a paired
range: the tree often shows the parts separately. Set each part, and move
between them with `right` or `tab` rather than looking for one field that takes
the whole thing.

`references/set-value-strategy.md` has worked calls per control family.
`references/chromium-ax-known-failures.md` lists what was measured, against
which app, on which date — read it as examples of the rule above, not as the
list of things that can go wrong.

## Never take the user's screen

Windows on another Space are in the tree and take actions like any other. They
are marked `[other Space]`, which says where they are, not that they are out of
reach.

- `computer_raise` is for one case: the app has no window in the tree at all,
  so there is nothing to read or press. It always asks the user first.
- Never raise to read, to press, or to look.
- To see an app, use `computer_app_screenshot`. It photographs one window
  wherever that window is, without disturbing anything.

## Canvases, and drawing

Some surfaces have nothing to press: a design canvas, a whiteboard, a drawing
area. The tree shows one big element and no controls inside it.

**A tool is usually a letter.** `computer_press_key` takes a single letter or
digit with modifiers, and is often the only way to reach a pen or shape tool at
all. Keys work on a background app on any Space.

**Then aim inside the element with `computer_pointer`.** Points are fractions
of that element's box, so `{"x":0.5,"y":0.5}` is its centre — no screen pixel
or display scale is involved. Give it the id of the canvas or web area, not the
window. Several points are separate clicks, which is how a pen tool takes a
path; `hold=true` makes them one press-drag-release.

**Pointer input is the one verb that needs the window visible:** it aims at
coordinates the app hit-tests. A window elsewhere is brought forward — do not
raise it first, and say the app came forward. Clicks do not move the user's
pointer.

**Clear the surface before the first point.** Apps float toolbars over a
drawing surface, often only once drawing begins, and a click on one ends the
path or switches the tool. Hide the app's panels with `computer_menu` — its own
command by name, never a guessed shortcut — then draw the whole shape in ONE
call: an app may not join a path continued in a second call.

**If you are asked to draw, draw.** Pasting an SVG or importing a file is not
drawing. Both are fine when the user asks for the artwork rather than the act;
when they ask for the pen, use the pen.

**Then fix the numbers in the app.** Clicking gives an approximate path. Design
tools expose exact position, size, stroke and colour as fields in the tree —
set those by id afterwards, which is faster and more accurate than clicking
precisely.

## Your working memory survives a summary only if you save it

A long conversation gets summarized, and the summary keeps the plan and drops
the numbers — measured, a run re-derived the same palette three times, and
another lost track of whether it had drawn its shapes or duplicated them.

- **Save it with `checkpoint_save`** whenever you finish a stage, and whenever
  a tool result says the context is nearly full. Write decisions, the plan, the
  measured numbers, names and colours, what is done and what is next. It
  replaces the previous checkpoint, so write everything you would need to
  resume. Element trees and screenshots are refused: they can be read again,
  and they are what fills the window.
- **The app records measured facts on its own** — every field a batch read
  back, where pointer clicks landed, what launched — into the same file under
  `./memories/`.
- **After a summary the file is handed back to you** with your next tool
  result. Read it before you act.

The first action past the threshold is held once until you have saved; the
reply carries the exact call.

**Measure once.** What you work out before acting — sizes and colours from a
source file, a scale, an offset — cannot be read off the app later. Save it
before the first action and work from what you wrote. Measured: one task
re-analysed its source file five times, and one of those analyses cost a
summary.

    # logo, design-app frame "Unbiased"
    palette: outer #1B4B8F, inner #E8F0FA, mark #F5A623
    circle: 500x500 at 320,180  DONE
    arc: 180x180 at 480,340     stroke 12  DONE
    text: not started

## Pictures

`computer_app_screenshot` photographs one app's window anywhere, including on
another Space. Use it when the tree cannot express what you need to see: a
rendered chart, whether a video is playing, how something is laid out.

A blank picture means the window has nothing drawn in it, which is what a
parked or never-shown window looks like. That is a fact about the picture, not
a reason to raise the app.

**A window that fills the display cannot be photographed while it is off
screen.** macOS keeps no full-size surface for it. Smaller off-screen windows
photograph fine. If you must see a full-screen app, raise it and use
`computer_screenshot`.

**If a picture does not arrive, do not conclude you are blind and keep
guessing.** The failure distinguishes a missing permission from a window that
cannot be captured where it is, and names the way round. When a task turns on
exact geometry or colour, measuring the source file with a shell command beats
squinting at any screenshot.

## Knowing when you are done

**When the app shows what was asked for, that is the answer.** Read it out of
the tree and stop. A request for directions is answered by the route on screen.
You do not need to see it rendered, and you do not need to confirm it twice.

Four runs have ended late rather than wrong. The worst spent a third of its
time pressing Walk, then Transit, then Drive, then Cycle, then Drive again, for
a request that named no travel mode at all.

- **Nothing else is part of the task.** Comparing alternatives, checking other
  tabs and taking a confirming look are all additions.
- **Do not change the app's settings.** Location, permissions and preferences
  are the user's.
- **Do not send an action twice to be sure.** A second press undoes a toggle or
  opens a second copy.
- **Report what you verified and what you did not.** If part of the task could
  only be checked weakly, say which part. A truthful "done, but I could not
  confirm the date field" is worth more than a confident wrong "done".
