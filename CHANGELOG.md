# Changelog

Notes shown in the app (Settings → Updates) and published as the release body.

Format matters: `## <version> — <date>`, then `### <section>`, then `-` bullets.

Write for the person using the app, not the person who wrote the code.

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
