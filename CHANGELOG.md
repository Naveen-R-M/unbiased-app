# Changelog

Notes shown in the app (Settings → Updates) and published as the release body.

Format matters: `## <version> — <date>`, then `### <section>`, then `-` bullets.

Write for the person using the app, not the person who wrote the code.

## 1.9.1 — September 3, 2026

### Fixed

- When macOS has not granted Accessibility access, the app now opens **Privacy & Security → Accessibility** for you instead of printing directions to it. Desktop control cannot grant itself that permission — a person has to switch it on — so the app puts you in front of the switch and says one line, rather than walking you through a window it was perfectly able to open. It also registers the app in that list, so there is a row to switch on even if it has never been granted before.

## 1.9.0 — September 3, 2026

### New

- **Desktop control.** Pareto can work in your other Mac apps — read what is on screen, click, type, use menus and keyboard shortcuts — from the conversation you are already in. It reads an app through macOS Accessibility rather than by looking at pixels, so it works from the app's own structure: it knows a button is a button and what it is called, instead of inferring it from a picture. Steps land on the control you meant, and work that used to cost a screenshot and a guess per step now costs neither. Turn it on with **Computer** below the message box. macOS asks for Accessibility permission the first time, and Pareto falls back to screenshots if it is not granted.
- Each desktop step shows the icon of the app it acted in, so a run that touches three apps reads as three apps rather than one undifferentiated list of clicks.

### Improved

- Desktop control asks your approval once per conversation, not once per action, and the request names the app and the specific control it is about to touch. In **Full access** it does not ask at all. Setting the mode back to **Ask** part-way through takes the approval back with it.
- Listing which apps are running never needs approval — it reads nothing from inside them.
- An app sitting on another Mission Control Space cannot be read from where you are, so Pareto brings it forward once and then works there. Apps already on your Space are worked on where they are, without pulling focus away from you.

### Fixed

- Keyboard shortcuts that use ⌘ now work. Copy, paste, select-all and every other Command shortcut were being sent as a key macOS does not have, so they silently did nothing.
- Screenshots no longer fail on large displays. A full-resolution capture could exceed the request limit and return an error instead of an image; captures are now scaled to fit, and clicks and screenshots finally agree on one set of coordinates.
- A window whose renderer crashes now recovers instead of leaving you with a blank grey rectangle you have to force-quit.
- Menus and popovers no longer open invisible when the window has been in the background.
- The menu on a conversation near the bottom of the sidebar stays on screen instead of opening past the edge.
- When a desktop action is blocked by permissions, the message names the app you actually need to find in System Settings, and errors that were not about permissions at all stop claiming they were.

## 1.8.2 — September 2, 2026

### Improved

- Clicking a project name in the sidebar collapses or expands it — the threads underneath fold away without needing a separate chevron, which is no longer shown.
- The menu that opens from a project or a conversation in the sidebar has a quieter, more deliberate feel: a translucent material with blur, compact icon tiles for each action, and a header that identifies what you are acting on before you commit.
- The copy icon no longer appears next to every working step while the assistant is busy. It shows once, under the final answer, where copying is actually useful.

### Fixed

- The thread actions menu — Rename, Move to project, Delete — now matches the project menu's styling instead of looking like a leftover from an earlier pass.

## 1.8.1 — September 2, 2026

### Improved

- The sidebar uses a translucent material now — enough blur to keep depth, enough pigment to keep text clear — with quiet neutral hover and selection states instead of a red accent stripe through every active destination. The footer fades into the nav instead of meeting it with a hard line.
- Rename and Delete on a conversation in the sidebar open a tighter menu: compact rows, a divider before the destructive action, and Delete is red so you know what you are committing to.
- A sub-agent's side panel no longer repeats its name and path in a bar below the header. The header already had it; the duplicate is gone, along with the status column that said the same thing a third way.

### Fixed

- Pasted images show as thumbnail previews in the conversation instead of a line of clip-emoji filenames. You see the picture you sent, not a reference to it.
- The instruction you gave a sub-agent now aligns to the left margin of the panel, below the agent's icon, instead of indenting to a second column that did not line up with anything. Both lines of the lifecycle row are the same size now.

## 1.8.0 — September 1, 2026

### New

- **Memory.** Pareto now keeps notes for a project and reads them at the start of every later conversation there, so a correction lands once instead of every week. It saves what a future chat would otherwise have to rediscover — a rule you stated, a fact about the project that is written down nowhere, the cause of something that took an hour to work out — with the reasoning behind it, not just the rule. Nothing is saved quietly: a **Saved Memory** pill appears under the answer that saved it, and opens the note itself. Everything lives in plain readable files under `.unbiased/memory` in your home folder, one per note. You can ask for a note to be forgotten, and you will be asked to confirm before anything is deleted — deleting a note cannot be undone. Memory is not available while plan mode is on, which stays read-only.
- **Connectors.** A page for connecting the services you already use — Slack, Linear, Notion, Figma and more — so Pareto can work in them. Sign-in happens in your browser; services that are not ready yet say **Coming soon** rather than offering a button that cannot work. The catalogue keeps itself current and the page opens from what it already knows, instead of waiting on the network to draw anything.
- Sub-agents a turn used now appear as pills under its answer, next to any memory it saved. Clicking one opens that agent's conversation in the side panel.

### Improved

- The **Worked for…** fold reads like an account of what happened instead of debug output. Steps are sentences with an icon — "Ran …", "Searched the web for …" — and the group says what kind of work it was. A step's output opens into a panel that names itself, with the command it ran above it. The whole fold is set in the same type as the answer it belongs to, and sits with that answer rather than floating between turns.
- Opening **Scheduled** or **Connectors** now puts the previous conversation's side panel away, the way switching conversations already did, and the page uses the whole window instead of the column the panel left behind.

### Fixed

- A sub-agent's conversation showed the task you gave it and nothing else — its reply was there the whole time, hidden by a filter meant to keep a parent conversation's history out of the agent's view. The reply is back, and the task still comes first.
- A command waiting for your approval no longer describes itself as already run, and no longer hides the middle of itself behind an ellipsis — you can read the whole thing before deciding, and it is marked as waiting.
- A step that failed with an error code shows the code again. It turned red and said nothing about why.

## 1.7.0 — August 28, 2026

### New

- **Edit with Pareto** on scheduled tasks. Drop screenshots of the exact screens a task works in — the Slack status dialog, the workspace picker — and Pareto rewrites the task's instructions around what is actually there: the real button labels, what success looks like, and a rule to stop and report instead of flailing when something will not click. The rewrite appears beside your current instructions and changes nothing until you accept it. If the first draft runs long it compresses itself to fit, rather than failing with a size error.

### Fixed

- Reopening a conversation no longer scatters it. The "Worked for…" grouping used to exist only while you watched live; reopen the chat and every line of interim narration stood bare with only the final answer among them. Reopened conversations now fold the same way — with the real duration on the header — and transcripts saved in the old scattered shape repair themselves when opened.
- The Agent browser works again after the 1.6.0 tab change. Selecting a conversation's tab quietly threw away everything the last page snapshot knew, so the agent would look at a page and then fail to click anything on it — a scheduled run lost its whole task to this. Also handled: sites that open your destination in a new tab (Slack's workspace **Launch** does) — the conversation now follows its work there, and so does the pane.
- A scheduled run that hits its ten-minute limit is now actually stopped. Before, the app only *recorded* the timeout and looked away while the run kept going with your signed-in sessions.
- On the Scheduled page, the Agent browser pane now shows the run that is browsing. It used to claim "the agent browser is not open" while a run visibly worked — and clicking Open run looked like it *started* the browser. It also now says "this conversation has not used the browser yet" when that is the truth.
- Content taller than the window on the Scheduled page spilled out of the app onto a bare white page bottom. Contained, and the page behind the app is dark now regardless.
- The side chat's empty state got the design pass: a proper mark, readable line lengths, and the "temporary" caveat set quieter than the definition.

## 1.6.0 — August 27, 2026

### New

- Scheduled runs tell you when they finish. A notification with the task's name and the first line of its answer; clicking it opens the run. Anything that came due while Unbiased was closed now runs once when you next open it, rather than waiting as "missed" for you to press a button — a morning brief should be ready when you sit down, not start when you do. A task missed for a week still runs once, against today's state.
- A scheduled task can name its own project. Ask for something recurring in a chat and it targets that project by default, or pick a different one on the form.

### Improved

- The dropdowns and the time picker on the scheduled form are drawn by the app. They were native controls, which is fine until they open — the list and the time panel came from the operating system, in its font on its blue highlight, and were the only thing on screen that did not belong here. Keyboard behaviour is unchanged: arrows, Home and End, Enter to choose, Escape to cancel, and typing a time still works. Minutes are listed in full, so 09:07 is still a time you can pick.
- New projects created without choosing a folder are made inside **Unbiased** in your home folder, instead of loose alongside Documents and Downloads.

### Fixed

- Two conversations browsing at once no longer fight over one page. Each chat gets its own tab in the Agent browser, so asking one for your Slack messages and another for the news does what you would expect. They still share one browser, so you stay signed in to everything.
- The Agent browser pane follows the conversation you are looking at. It could show another chat's page — you would ask about Slack and watch someone else's news feed scroll past. A chat that has not browsed yet now shows nothing rather than borrowing a page from one that has.
- Switching conversations while a chat is working no longer closes its Agent browser. The pane is remembered per conversation and comes back when you return to it, and a chat browsing in the background no longer opens a pane in the chat you are reading.
- Row buttons in the MCP and Skills lists were invisible. They were painted in exactly the shade of the panel behind them.

## 1.5.0 — August 25, 2026

### New

- Scheduled tasks. A **Scheduled** entry in the sidebar, where you can set Pareto to run something on its own — a weekday brief, a Friday summary, a watch on work in progress. Start from one of the suggestions or write your own. Tasks run read-only and only while Unbiased is open; anything that came due while it was closed waits for you as "missed" rather than firing a backlog the moment you launch. You can also just ask Pareto for something recurring in a conversation: it proposes the task, shows you a card with the schedule and the exact instructions it wrote, and creates it only if you approve.
- Skills. A **Skills** entry in the **+** beside the message box, listing what Pareto knows how to do — for this project and everywhere — and letting you add more from a folder, a .zip or a link. What a skill ships is checked before anything is copied, and any scripts it carries are listed for you to see first.
- Drag files, folders and images straight into a conversation. They attach exactly as they would from the **+** menu — folders as folders, images as images.

### Improved

- The interface had a pass over its motion and typography. Animations now use a proper curve instead of the browser default, so things feel like they respond rather than drift. Text sizes carry the right letter-spacing for their size, replies are held to a comfortable line length, and the sidebar reads as a hierarchy instead of one flat list. Buttons, selected rows and section labels look the same wherever you meet them.
- Keyboard focus is finally visible. Every control used to remove the focus ring and put nothing back, so tabbing through the app showed you nothing at all.
- Motion respects "Reduce motion". If you have it on in macOS accessibility settings, the decorative shimmer stops and things stop sliding; the indicators that tell you a turn is running stay, because those carry meaning.
- MCP servers show their own logo instead of a coloured dot, and say **Connected** in words. Whether a server is connected was previously only distinguishable by colour.
- Opening a project, attaching a file and adding a skill each reopen where you last were, instead of every picker starting from the same place and making you walk the same folders again.
- The **+** menu is laid out in columns and split into what you add versus what Pareto can do, and plan mode shows whether it is on rather than only offering to turn it on.

### Fixed

- Annotating text in a side chat now highlights the excerpt. It had always shown the numbered badge with no colour behind it — the highlight was being registered under a name nothing could match.
- The browser you watch is the browser the agent is using. The agent was driving a browser of its own while the Agent browser panel showed a different one, which is also why sites kept asking it to sign in; and asking for the agent browser in a *side* chat got "I don't have that tool", because a side chat was being given no tools at all.
- Text on accent-coloured buttons is legible. The app was picking white where dark was nearly twice as readable, which put those labels below the accessibility minimum.
- Copy and the time it landed are on every reply, not just the newest one.
- Sub-agent rows keep their names after you reopen a conversation, instead of reverting to raw task names.
- Starting a new chat gives you a fresh side panel, rather than the previous conversation's browser page still sitting there.
- Dropping a file anywhere the app was not expecting one no longer blanks the window. It was treated as a navigation, which replaced the whole app with the file and lost everything you had open.

## 1.4.0 — August 24, 2026

### New

- MCP servers. Pareto can use tools from Model Context Protocol servers now. The **+** beside the message box has an MCP entry showing what is connected and what each server offers, and you can add your own — either a program on this machine or something already listening on a URL, including local apps like Figma's Dev Mode server. A server you add connects the next time the engine starts, and the panel offers to restart it for you.

### Fixed

- A tool from an MCP server no longer refuses itself. Every call used to come back as "user rejected MCP tool call" — a refusal you were never asked about. You now get a permission card naming the server and the tool, and answering it runs the tool.
- Steps an MCP server runs show up in the conversation, and a failed one says why. They previously left no trace at all, so a tool that ran, or didn't, looked identical.
- "Error: engine exited with code null" no longer appears while the engine is running perfectly well. Restarting the engine reported the outgoing one's shutdown as a failure of its replacement, which also cancelled whatever the new one was in the middle of.

## 1.3.3 — August 24, 2026

### Added

- Watch the agent browse, inside the app. When the agent uses the web, an **Agent browser** panel opens beside the conversation showing the page live — and you can click, scroll and type in it, which is where you sign in to sites now. No second Chrome window appears on your desktop any more. The panel arrives with the browsing and leaves when the turn ends; reopen it any time from the "Agent Browser" link in the conversation.
- The assistant now splits work across sub-agents on its own when a task has genuinely independent parts, instead of waiting to be asked.

### Fixed

- A permission card no longer counts as "the model returned an empty response". A turn whose only visible result was a request for permission was reported as empty, and a second one told you to abandon a perfectly healthy conversation.
- Closing the last panel tab closes the panel again, instead of leaving an empty strip behind.
- Sub-agent rows say who they are: "Created 🍄 Singer" rather than "Created an agent".

## 1.3.2 — August 21, 2026

### Fixed

- An automatically downloaded update now tells you it is ready. It used to download and stage itself silently, then show the "Relaunch to update" banner only after your next restart — you could sit on a finished update for hours without knowing.
- A conversation that was mid-command when you quit no longer says "Working…" forever when you reopen it. Those steps now read as canceled, since the run ended with the app.
- No more sideways scrollbar in the What's new popup.

## 1.3.1 — August 21, 2026

### Fixed

- A permission request left unanswered when you quit now says so when you come back, instead of showing Allow and Deny buttons that do nothing. The turn behind it ended with the app, so the request cannot be answered — the card says that plainly and you can simply ask again.
- Security: a permission card restored from a closed session could, in rare cases, answer a different request made after reopening — approving something you never saw. Requests are now tagged per session so an old card can never be mistaken for a new one.

## 1.3.0 — August 21, 2026

### New

- Updates now download in the background. When one is ready the app asks you to restart, and nothing changes until you do. Settings has a new Updates page where you can turn that off, see your version, and read what changed in it.

### Improved

- Settings is reorganised: grouped navigation with icons, and the same layout and text sizes on every page.
- What's new is written once and published with the release, so the notes you read in the app are the notes on the release itself.

### Fixed

- A new chat appears in the sidebar the moment you send the first message. Starting one and walking away used to look as though the chat had been thrown out — it was there and running the whole time, just invisible until it finished.
- Selecting code in a code block stays selected, so you can copy it. Selecting ordinary text always worked; code did not.
- A new chat no longer shows the previous conversation's context usage, and Compact acts on the conversation you are actually in. The title bar shows the real conversation name instead of staying on "New chat".
- An update that fails no longer loops. A finished download used to be forgotten on restart, so the app fetched the same version over and over.

## 1.2.3 — August 21, 2026

### New

- Links in a reply now show the site's icon beside them, so you can tell at a glance where a source comes from.

### Improved

- The message box grows as you type or paste, instead of staying two lines tall and hiding the rest behind a scrollbar.
- Pasting a link pastes the link. Copying one out of a page often gives you markdown brackets around it; those are dropped now.

### Fixed

- Security: when two commands were waiting for approval at once, a single Enter approved both. Enter now acts only when one is waiting — with more than one, you choose each explicitly.
- Security: an approval could be answered by the wrong card, which also left the other one waiting forever on a reply that never came.
- Sub-agents started from a side chat show up in the list again. They were invisible, and their rows in the transcript led nowhere.
- Closing the last browser tab while a long conversation was loading no longer leaves the side panel open on a tab that is not there.
- The tab limit follows one rule: tabs holding something live — a terminal, a page, a chat — refuse when full, while plain views make room by closing the oldest.

## 1.2.2 — August 19, 2026

### Fixed

- Long conversations now summarize themselves before they outgrow the model's context window. Previously nothing ever compacted, so a long thread could grow past what the service accepts — and once it did, every message in it failed, including a plain “Hello”.
- The context meter tells the truth instead of stopping at 100%. Over the limit it says so, and offers Compact right there rather than hiding it below the usage details.

## 1.2.1 — August 19, 2026

### Fixed

- Security: text the assistant typed into a page could be misread as a command-line option by the browser tool, including one that changes which program it launches. Text is now entered directly into the page and never reaches that parser.
- Browser steps in the transcript show as running while they are still going, instead of jumping straight to done.

## 1.2.0 — August 19, 2026

### New

- The assistant can browse the web. Ask it to look something up and it searches, reads pages, clicks through, and can take screenshots — reporting what it actually saw rather than what it remembers. Requires the agent-browser tool to be installed.
- Signed-in browsing: when a task needs your own accounts (your email, a dashboard, an admin panel), the assistant asks permission and the app opens a browser window for it. Sign in there once and it stays available for later requests.
- Every side-panel surface now opens in multiple tabs — up to five each of sub-agent conversations, side chats, browsers, terminals, file trees, and file viewers.
- The side panel remembers itself per conversation: leave a chat and come back to find the same tabs, with the one you were reading still in front.
- Creating a project now uses the full project editor — name, icon and color, and as many source folders as you want.
- This “What’s new” log, reachable from the bell beside Settings, with a dot when there is something you have not read.

### Fixed

- Deleting a conversation or worktree from Settings → Resources now asks first, and spells out exactly what gets removed.
- Sub-agent conversations in Settings → Resources are named (nickname, task, and the conversation that spawned them) instead of showing a raw id.
- Chats outside a project now run in a dedicated ~/Unbiased folder. Previously they ran in your home directory, which let a personal Codex CLI config leak into the app and break turns with a tool error.
- Diagrams and other code blocks without a language tag render as proper blocks instead of ragged inline text.
- The stored API key is kept on sign-out by default, so signing back in is one click. The toggle is in Settings.
- Interrupting a chat now also stops its sub-agents, and permission cards that no longer apply are retired instead of sitting there live.
- A permission card raised by the app itself no longer stays stuck on “running” after you answer it.
- The update banner shows its status inline with a face — glum while an update waits, cheerful once it is ready to relaunch.

## 1.1.0 — August 18, 2026

### New

- Sub-agents: the assistant can spawn parallel agents to split up a task. Each gets a nickname, shows up in the environment popover, and leaves lifecycle rows in the chat (“Created an agent”, “Messaged an agent”, “Closed an agent”).
- Click a sub-agent’s name to open the agent-to-agent conversation in the side panel, rendered with the same formatting as the main chat.
- A turn’s intermediate work now folds under a “Worked for …” header when it finishes, Codex-style.
- Projects: create one from the + button in the sidebar, give it an icon and a color, and attach multiple folders with a primary.
- Rename conversations, move them into projects, and delete conversations and worktrees from Settings → Resources.
- The composer rotates through fresh placeholder prompts in existing chats.
- New setting to keep the stored API key when signing out.

### Fixed

- Code blocks are syntax-highlighted, and every copy button flashes a tick to confirm the copy.
- Thinking and waiting status shimmer, and durations read as whole seconds.
- A sub-agent’s permission request lands in the main chat naming the agent, and interrupting a chat now also stops its sub-agents and retires stale Allow/Deny cards.
- Corrections sent to a busy sub-agent appear in its conversation immediately instead of after it finishes.
- Long commands wrap inside their cards instead of stretching the chat.
- Message timestamps appear when hovering the actions row.

## 1.0.6 — August 17, 2026

### New

- The usage popover shows real credits and spend from your account.

### Fixed

- New releases are noticed right away instead of waiting for the six-hour check.

## 1.0.1 – 1.0.5 — August 17, 2026

### New

- In-app update banner with self-installing updates — downloads in the background, relaunches on demand.
- The mascot joined the update banner.

### Fixed

- Installer reliability: staged installs and a macOS mount-point fix.

## 1.0.0 — August 17, 2026

### New

- Initial release: chat with Pareto, worktrees, plan mode, the Review pane, an integrated terminal, an embedded browser with annotations, a real file viewer, and themes.
