# When a press is accepted and nothing happens

Distinct from a write that is discarded (see `set-value-strategy.md`). This one
is about clicks dying on a window Stage Manager has parked.

**You are usually told before you try.** A read of a parked app opens with a
line saying so and naming the call to use instead. Act on that line.

**What it looks like.** The action succeeds and reports no change. The element
is still there and still looks pressable. Pressing again does nothing.

**Why.** Stage Manager shrinks the windows of apps the user is not looking at
into the side strip. A window shrunk to a thumbnail stops hit-testing its
contents, so anything that works by being clicked does nothing: list rows, the
buttons on a card, segmented tabs. It does not affect typing, posted keys, or
menu bar items — none of those go through hit-testing.

**Readable is not interactable.** The tree you read is exact. What you press
may simply not land. Trust what you read; change how you act.

**Do not press again, and do not raise.** Raising un-parks the window only
while that app is in front, and it re-parks the moment focus moves on — one run
raised and eleven seconds later the next press was dead again. Moving or
resizing does not help either: parking follows which app is ACTIVE, not where
the window sits. One run spent five turns in `Window > Move & Resize` and
finished without the route it was asked for.

## Do this instead

1. **Say the whole intent in the search field, not just the object.** Apps
   offer the finished action as a suggestion when you ask for it. In Maps,
   setting the search field to `directions to AMC River East 21` puts
   `Directions to AMC River East 21, From My Location` at the top — skipping
   the result row, the place card and the directions button in one move. One
   run spent eighty seconds discovering that the card's button could not be
   pressed at all.
2. **Commit with the keyboard.** `down`, then `return`. Return alone often does
   not take the suggestion, and `down` alone only moves the selection — keep
   them in one route.
3. **Otherwise the menu bar.** Its items are in the tree and reach every command
   the app has.

Send all three as `candidates` in one call, in that order, rather than finding
out one turn at a time.

Measured on a parked Maps window: search field, `down`, `return` produced the
full driving route in three calls, no clicking, no change to the screen.

If the task truly cannot be done without clicking, say so, and tell the user
that turning Stage Manager off in System Settings under Desktop and Dock
removes the problem. Do not turn it off yourself.
