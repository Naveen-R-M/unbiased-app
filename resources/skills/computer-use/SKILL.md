---
name: computer-use
description: How to drive the user's own macOS apps with the computer_ tools — reading the element tree, acting by id, what to do when a press is accepted but nothing happens, and working on apps that are on another Space. Read this before the first computer_ call in a task.
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

**Read again only when the ids you need are not in front of you**, or when an
action reports that nothing changed and you expected something.

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
digit, with modifiers. This is often the only way to reach a tool at all —
Figma's pen is `p` and it has no element, no menu item and no other route. Keys
work on a background app on any Space, because a key event does not care where
the window is.

**Then aim inside the element with `computer_pointer`.** Points are fractions
of that element's box, so `{"x":0.5,"y":0.5}` is its centre and you never touch
a screen pixel or a display scale. Give it the id of the canvas or web area,
not the window. Several points are separate clicks, which is exactly how a pen
tool takes a path; `hold=true` makes them one press-drag-release. The reply
tells you the screen points your fractions landed on, so you can correct your
geometry from fact rather than guesswork.

**Pointer input is the one thing that needs the window really visible.** It
aims at real screen coordinates and the app hit-tests them, so it is refused
when the window is parked or on another Space — a click there would land on
whatever IS at that spot. So this kind of work is foreground work: raise the
app, say to the user that drawing needs the screen, and do it.

**If you are asked to draw, draw.** Pasting an SVG or importing a file is not
drawing, and substituting one for the other is answering a different request.
Both are fine when the user asks for the artwork rather than the act; when they
ask for the pen, use the pen.

**Then fix the numbers in the app.** Clicking gives you an approximate path.
Design tools expose exact position, size, stroke weight and colour as fields in
the tree — set those by id afterwards, which is faster and more accurate than
trying to click precisely.

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
