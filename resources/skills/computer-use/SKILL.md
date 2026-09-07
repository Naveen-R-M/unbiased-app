---
name: computer-use
description: How to drive the user's own macOS apps with the computer_ tools — reading the element tree, acting by id, what to do when a press is accepted but nothing happens, and working on apps that are on another Space. Read this before the first computer_ call in a task.
---

# Driving the user's apps

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

**What you will see.** The action succeeds and reports no change. The element is
still in the tree, still looks pressable, and pressing it again does nothing
either. The reply usually explains why.

**What is happening.** Stage Manager parks the windows of apps the user is not
looking at into the side strip as thumbnails. A window shrunk to a thumbnail
stops hit-testing its contents, so anything that works by being clicked does
nothing. It affects list rows, the buttons on a place or detail card, and
segmented tabs. It does not affect typing into a field, keys you post, or menu
bar items, because none of those go through hit-testing.

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

1. **Say the whole intent in the search field, not just the object.** Apps offer
   the finished action as a suggestion when you ask for it. In Maps, setting the
   search field to `directions to AMC River East 21` puts
   `Directions to AMC River East 21, From My Location` at the top of the
   results, which skips the result row, the place card and the directions
   button in one move.
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

## Pictures

`computer_app_screenshot` photographs one app's window anywhere, including on
another Space. Use it when the tree cannot express what you need to see: a
rendered chart, whether a video is playing, how something is laid out.

A picture that comes back blank means the window has nothing drawn in it, which
is what a parked or never-shown window looks like. That is a fact about the
picture, not a reason to raise the app. The tree still has the text.

`computer_screenshot` captures the whole display, so it shows the current Space
only. An app on another Space is not in it.

## Scope

Do what was asked, and stop when the result is on screen.

- Do not change the app's settings. Location, permissions and preferences are
  the user's, and toggling one to make a task easier is not part of the task.
- Do not verify alternatives nobody asked for. A request for directions is not a
  request to compare every travel mode.
- Do not repeat an action to be sure it took. A second press undoes a toggle or
  opens a second copy.
