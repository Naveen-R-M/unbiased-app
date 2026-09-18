# Setting a value: pick the route the control honours

The rule this table serves: **an advertised capability is not proof.** Every
control below reports its value as settable, and several silently discard the
write. Recognise the family, pick the route, then verify — see
`verification.md`.

**`set_value` does not retry for you.** It can — pass `escalate: true` and it
will click in, select what is there and type the value when the write does not
take, reporting `route: "typed"` if it had to. That is off by default, and the
reason is worth knowing before you turn it on: deciding *when* a write failed
means telling "it landed and the read is stale" from "it was discarded", and
those look identical through the accessibility layer. Getting that wrong types
the value on top of itself — measured, a name became "NaveenNaveen" and an
email was written three times over.

So ask for it only where you already know the control refuses writes, and
expect to check the result either way. What follows is the route to use.

## Recognising the family

Read it off the element's line. The role and the action list are both in it:

    32  incrementor "Seats" {press,increment,decrement}
    25  pop up button "Country" = India {press,show menu}
    21  text field "Last name" = Kumar {press,show menu}

`increment`/`decrement` appear on nothing but steppers, so that pair is a
reliable way to recognise one. It is NOT a reliable way to drive one — see
below.

## Text field, text area

1. `set_value` — works, and reads back straight away when the field was empty.
2. Replacing existing content: **select first**, then type. `select_text` with
   no `text` selects the whole value; typing then replaces it. Typing without
   selecting APPENDS, which is how a `12` becomes `121212`.
3. `set_value` with an **empty string is silently ignored**. To clear a field,
   select its contents and type the new value in one go — do not clear as a
   separate step.

Never open a replace with `command+a` and `delete` before clicking into the
field. With focus outside a field those select every object in the document and
delete them; measured, it cleared a canvas mid-task. `select_text` is scoped to
the element by construction and cannot do that.

## Incrementor / stepper

`set_value` is silently ignored. So are `increment` and `decrement`: they are
advertised, they return `ok`, and the value does not move.

Use the keyboard:

```json
{"app": "<app>", "steps": [
  {"do": "pointer", "id": 84},
  {"do": "select_text", "id": 84},
  {"do": "type", "text": "12"},
  {"do": "key", "key": "return"}
]}
```

Arrow keys (`up`, `down`) also work and are reasonable for a small delta from a
known current value.

## Pop-up button / native select

`set_value` is silently ignored.

**`show menu` is a trap on a control inside a web page.** It is in the action
list, and it opens the BROWSER's context menu rather than the control's own
options — measured, and it costs a turn plus an escape to get out of. The
action being advertised is not the action you get.

What has worked:

1. **Focus it and type the first letter of the option**, then `return`. One
   call, and it is how a person uses a closed select. Do not send `return`
   while a closed select has focus inside a FORM unless you mean to submit —
   on a form it submits.
2. **Or press it and read again.** A native menu opens as its own small tree,
   separate from the page; its items are not in the page's element list and
   the ids you had before may no longer resolve. Read, then press the item.

Verify which option is selected afterwards. The control's value is the option's
text, so a read tells you — weakly; see `verification.md`.

## Date field

The field itself refuses a write; its month, day and year sub-fields are
separate steppers in the tree. Focus a sub-field, select, type, then move on
with `right` or `tab`. Typing into a sub-field works and sets it exactly.

## Canvas or unknown custom control

No value to set. Use the pointer and the keyboard, and expect nothing in the
tree to describe what is drawn. Do not report success you cannot see.

## If none of these land

Say the control could not be set and what you tried. An unverified report is
worth more than a confident wrong one, and far more than five identical retries.
