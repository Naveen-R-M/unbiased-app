---
name: computer-use
description: How to drive the user's own macOS apps with the computer_ tools — reading the element tree, acting by id, what to do when a press is accepted but nothing happens, and working on apps that are on another Space. It is handed to you automatically with the result of your first computer_ call in a conversation — do not open this file yourself; reading it here and receiving it there costs a turn and puts it in context twice.
---

# Driving the user's apps

You are handed this with your first desktop call of a conversation, so read it
before you act rather than after something fails.

These tools operate the apps already open on the user's Mac, as text. An app is
a tree of elements, each with an id, and you act on ids. The screen stays where
the user left it: reading and acting work on a background app, on any Space,
and none of it needs the app in front.

## The loop

**Read once, then act.** `computer_app_state` returns the tree. Every action
returns what changed, so do not follow an action with a read. Pressing a search
result returns the card it opened; pressing a tab returns that tab's contents.

**Batch what you already know.** `computer_do` runs several steps on one app in
one call. Use it as soon as the next few moves are certain: fill a field, send
Return, read. Each avoided round trip is seconds off the task.

`computer_do` takes up to **30 steps**, and a step can be anything the single
tools do: a tool shortcut (`{"do":"key","key":"p"}`), a modified key
(`{"do":"key","key":"a","modifiers":["command"]}` to clear a field before
typing), a value, a press, a read.

A turn costs about fifteen seconds whatever it carries, so the unit of work is
the turn, not the action. Setting one shape's x, y, width, height and colour is
ONE call with five steps, not five calls. Measured on a drawing task: 372 actions
arrived nearly one per turn and the run took 23 minutes, where the same actions
batched by shape would have been about 40 turns. Every step in a batch also
skips the wait for the app to react — only the last one waits — so a batch of
five is faster than five singles by more than the round trips alone.

**Read again only when the ids you need are not in front of you**, or when an
action reports that nothing changed and you expected something. After a press,
a click or a batch the reply ends with `Inspector now:` — every settable
control with its id and current value — so the next field to click is already
named; do not search for it. To look while you work, put
`{"do":"screenshot"}` inside the batch: the picture comes back with the same
result, and a separate screenshot call is a whole turn spent on looking.

**When you can see several ways to do one thing and cannot tell which the app
will honour, send them as candidates.** `computer_do` takes `candidates`
instead of `steps`: alternative routes to one state, tried in order, stopping
at the first that changes the app. A route is a step or a short list of steps,
because the one that works is often two moves.

```json
{"app": "Maps", "candidates": [
  {"do": "press", "id": 88},
  [{"do": "key", "key": "down"}, {"do": "key", "key": "return"}]
]}
```

Three guesses then cost one turn instead of three. Read the diff afterwards and
confirm the state is the one you wanted, because "it changed something" is not
"it worked". Use it only for things you would not mind happening twice.

## Ids

Ids are stable per app until an element disappears, and they do not survive the
app rearranging itself. Two rules follow.

- An id whose control the app rebuilt is re-found for you. If exactly one
  element still matches what that id described, the action lands on it and the
  reply gives you the new number to use from then on.
- An id that matches nothing, or matches two things, is refused immediately and
  says to read again. That is cheap. Read and continue rather than guessing a
  neighbouring number.
- An action the element does not list is refused before it is attempted, and the
  refusal names the actions it does list. Use one of those.

## Never take the user's screen

Windows on another Space are in the tree and take actions like any other. They
are marked `[other Space]`, which tells you where they are, not that they are
out of reach.

- `computer_raise` is for one case only: the app has no window in the tree at
  all, so there is nothing to read or press. It always asks the user first.
- Never raise to read, to press, or to look at something.
- To see an app, use `computer_app_screenshot`. It photographs one window
  wherever that window is, without disturbing anything.

## When a press is accepted but nothing happens

This is the failure worth knowing about, because the wrong reaction to it costs
more time than anything else in a task.

**You will usually be told before you try.** A read of an app whose window is
parked opens with a line saying so and naming the call to use instead. Act on
that line rather than pressing something to find out.

**What it looks like if you do press.** The action succeeds and reports no
change. The element is still in the tree, still looks pressable, and pressing
it again does nothing either. The reply explains why and ends with the exact
call to send next.

**What is happening.** Stage Manager parks the windows of apps the user is not
looking at into the side strip as thumbnails. A window shrunk to a thumbnail
stops hit-testing its contents, so anything that works by being clicked does
nothing. It affects list rows, the buttons on a place or detail card, and
segmented tabs. It does not affect typing into a field, keys you post, or menu
bar items, because none of those go through hit-testing.

**Readable is not interactable, and that is the distinction to hold onto.** The
tree you read is exact: every element, every title, every value. What you press
may simply not land. So trust what you read and change how you act.

**Do not press it again, and do not raise the app.** Raising un-parks the window
only while that app is in front. It re-parks the moment focus moves on: one run
raised, and eleven seconds later the next press was dead again. The bridge
refuses the first raise you ask for while a window is parked, and tells you the
keyboard route instead. A window in this state is also marked `[parked]` when
you read its windows, so you can see it coming.

**Do not try to move or resize the window either.** Parking follows which app
is ACTIVE, not where the window sits, so another Space does not help and
neither does `Window > Move & Resize`. One run spent five turns in that menu
and finished without the route it was asked for.

**Do this instead.**

1. **Say the whole intent in the search field, not just the object.** This is
   the one to reach for when the control you need cannot be pressed at all —
   a button on a card, rather than a row you could arrow onto. Apps offer the
   finished action as a suggestion when you ask for it. In Maps, setting the
   search field to `directions to AMC River East 21` puts
   `Directions to AMC River East 21, From My Location` at the top of the
   results, which skips the result row, the place card and the directions
   button in one move. Reaching that route panel by pressing the card's drive
   button is not possible while parked, and one run spent eighty seconds
   discovering that.
2. **Commit with the keyboard.** Send `down`, then `return`. Return on its own
   often does not take the suggestion. Arrow keys move through any result list,
   and this works on a parked window.
3. **Otherwise use the menu bar.** Its items are in the tree and reach every
   command the app has.

All three are worth sending together as candidates in one call, in that order,
rather than finding out one turn at a time. Keep down and return in one route:
down only moves the selection, so a route that stops there has not opened
anything. When a click dies this way the reply ends with the exact call to
send next — send that.

Measured on a parked Maps window: search field, `down`, `return` produced the
full driving route with three calls, no clicking, and no change to the screen.

If the task truly cannot be done without clicking, say so and tell the user that
turning Stage Manager off in System Settings under Desktop and Dock removes the
problem. Do not turn it off yourself.

## Canvases, and drawing

Some surfaces have nothing to press: a design canvas, a whiteboard, a drawing
area. The tree shows one big element and no controls inside it. Two things get
you in.

**A tool is usually a letter.** `computer_press_key` takes a single letter or
digit, with modifiers. This is often the only way to reach a tool at all — a
pen or shape tool is one letter, with no element, no menu item and no other
route. Keys work on a background app on any Space.

**Then aim inside the element with `computer_pointer`.** Points are fractions
of that element's box, so `{"x":0.5,"y":0.5}` is its centre and no screen
pixel or display scale is involved. Give it the id of the canvas or web area,
not the window. Several points are separate clicks, which is exactly how a pen
tool takes a path; `hold=true` makes them one press-drag-release. The reply
tells you where your fractions landed.

**Pointer input is the one verb that needs the window visible:** it aims at
screen coordinates the app hit-tests; reading, keys and menus do not. A window
elsewhere is brought forward — do not raise it first — and the pointer goes
back where the user left it. Say the app came forward.

**Clear the surface before the first point.** Apps float toolbars over a
drawing surface, often only once drawing begins, and a click on one ends the
path or switches the tool. Fit the target and hide the app's panels or go full
screen — `computer_menu` runs the app's own command by name; never guess a
shortcut — then draw the whole shape in ONE call: an app may not join a path
continued in a second.

**If you are asked to draw, draw.** Pasting an SVG or importing a file is not
drawing, and substituting one for the other is answering a different request.
Both are fine when the user asks for the artwork rather than the act; when they
ask for the pen, use the pen.

**A number field in a web app takes four steps, not one.** This is the single
thing that wastes the most time in a design tool, so it is worth knowing
exactly:

- The tree calls it a **text field** (width, height, opacity, a hex box):
  `set_value` works and the value reads back straight away.
- The tree calls it a **stepper** (x, y, rotation): `set_value` is **silently
  ignored**. The number appears in the box, the actual value never changes, the
  tree keeps reporting the old one, and then it commits when focus leaves. That
  is how a `67` becomes `100100`.

For a stepper, do what a person does — in ONE call:

```json
{"app": "<the app>", "steps": [
  {"do": "pointer", "id": 84},
  {"do": "key", "key": "a", "modifiers": ["command"]},
  {"do": "type", "text": "-19.6875"},
  {"do": "key", "key": "return"}
]}
```

`pointer` with no path clicks the middle of the element. Add `"clicks": 2` if a
single click does not open the field. Then **read the value back**: a field can
reject what you typed and fall back to 0, and only a read tells you.

Never open that sequence with `command+a` and `delete` before clicking. With
focus outside a field, those select every layer in the document and delete
them — measured, it cleared a canvas mid-task.

Presses cannot be checked this way, so read the diff a batch returns rather
than assuming all thirty steps did something.

**Then fix the numbers in the app.** Clicking gives you an approximate path.
Design tools expose exact position, size, stroke weight and colour as fields in
the tree — set those by id afterwards, which is faster and more accurate than
trying to click precisely.

## Your working memory survives a summary only if you save it

A long conversation gets summarized, and the summary keeps the plan and drops
the numbers — measured, a run re-derived the same palette three times, and
another lost track of whether it had drawn its shapes or duplicated them. So
there is a checkpoint, and it works in three parts.

- **Save it with `checkpoint_save`** whenever you finish a stage of a long
  task, and whenever a tool result tells you the context is nearly full. Write
  decisions, the plan, the measured numbers, names and colours, what is done
  and what is next. It replaces the previous checkpoint, so write everything
  you would need to resume. Element trees and screenshots are refused: they
  can be read again, and they are what fills the window.
- **The app records measured facts on its own** — every field a batch read
  back, where pointer clicks landed, what launched — into the same file under
  `./memories/` in the working directory.
- **After a summary the file is handed back to you** with your next tool
  result. Read it before you act: it is the ground truth for what you already
  finished, and the tree says whether it is still there.

The first action you send past the threshold is held once until you have
saved; the reply carries the exact call. Save, then send the action again.

**Measure once.** What you work out before acting — sizes and colours read
from a source file, a scale, an offset — cannot be read off the app later.
Save it with `checkpoint_save` before the first action and work from what you
wrote. Measured: one task re-analysed its source file five times, and one of
those analyses cost a summary. Measure again only if the checkpoint is missing
or something on screen proves a number wrong.

What a good note looks like — small, exact, and about the work rather than the
screen:

    # logo, design-app frame "Unbiased"
    palette: outer #1B4B8F, inner #E8F0FA, mark #F5A623
    circle: 500x500 at 320,180  DONE
    arc: 180x180 at 480,340     stroke 12  DONE
    text: not started

This is also how you answer "is it done?" honestly: the checkpoint says what
you actually completed, and the tree says whether it is still there.

## Pictures

`computer_app_screenshot` photographs one app's window anywhere, including on
another Space. Use it when the tree cannot express what you need to see: a
rendered chart, whether a video is playing, how something is laid out.

A picture that comes back blank means the window has nothing drawn in it, which
is what a parked or never-shown window looks like. That is a fact about the
picture, not a reason to raise the app. The tree still has the text.

**A window that fills the display cannot be photographed while it is off
screen.** macOS keeps no full-size surface for it, and the refusal says so.
Smaller off-screen windows photograph fine. If you need to see a full-screen
app, raise it and take a display screenshot with `computer_screenshot`; that
path works whenever the window is actually visible.

**If a picture does not arrive, do not conclude you are blind and keep
guessing.** Read the failure: it distinguishes a missing permission from a
window that cannot be captured where it is, and it names the way round. And
when a task turns on exact geometry or colour, measuring the source file with a
shell command beats squinting at any screenshot.

`computer_screenshot` captures the whole display, so it shows the current Space
only. An app on another Space is not in it.

## Knowing when you are done

**When the app shows what was asked for, that is the answer.** Read it out of
the tree and stop. A request for directions is answered by the route on screen.
A request to find something is answered when it is on screen. You do not need to
see it rendered, and you do not need to confirm it a second way.

Four runs have ended late rather than wrong. The worst spent a third of its time
pressing Walk, then Transit, then Drive, then Cycle, then Drive again, for a
request that named no travel mode at all.

- **Nothing else is part of the task.** Comparing the alternatives, checking the
  other tabs, and taking a confirming look are all additions.
- **Do not change the app's settings.** Location, permissions and preferences
  are the user's, and turning one on to make a task easier is not part of it.
- **Do not send an action twice to be sure.** A second press undoes a toggle or
  opens a second copy, and the bridge refuses a repeat that already changed
  nothing.
