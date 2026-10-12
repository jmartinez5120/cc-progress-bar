# progress-bar

A Claude Code mod that draws a full-width progress bar above the prompt, showing how far along Claude is on the task you gave it, including the subagents it spawns.

```
▕██████████████████████████████████▌░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▏  50%
  Writing fix · 1/3 tasks · 0/1 agents · 12 tools
    ⎿ ◐ Explore · find the bug
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install progress-bar --marketplace jmartinez5120/cc-progress-bar
```

Answer `y` to add the marketplace, then press Enter to install at user scope. The bar is active immediately.

## How progress is measured

- **Todos and tasks.** Claude's `TodoWrite` list and `TaskCreate`/`TaskUpdate` tasks: completed = 1, in progress = ½, pending = 0.
- **Agents.** Every spawned subagent is one unit, nested ones included (drawn indented under their parent): running = ½, finished or failed = 1.
- **Turn end.** The bar holds at 99% while Claude is still working and reaches 100% only when the turn really ends, with the total time since your prompt. An interrupted turn shows as `interrupted`.
- **Background agents.** If the turn ends with agents still running, it shows `waiting on N background agents`. Their hand-backs continue the task instead of resetting it.
- **Nothing countable.** With no todo list, tasks or agents, the bar estimates from activity: it advances with each tool call along a flattening curve (about 40% after 7 calls, 75% after 20), never past 90%, and shows the percentage as `~NN%`. It reaches 100% when the turn ends.
- **Agents it missed.** On each turn start and tool call it reads Claude Code's agent list, adding running agents it never saw start (for example, ones spawned before the plugin loaded) and settling ones that ended.
- **New task.** Only a prompt from a person (terminal, Remote Control, SDK, scheduled task) starts a new task; finished work is cleared, unfinished todos and running agents are kept.

The bar spans the terminal's width and follows it when you resize.

## What it accesses

The bar is drawn only from events inside your Claude Code session: tool calls (it reads `TodoWrite`, `TaskCreate` and `TaskUpdate` inputs, and counts every call), subagent starts and ends, and turn starts and ends. It keeps its counts in session state.

It makes no network requests, reads or writes no files, runs no processes, and does not change prompts, tool calls, tool results or permissions: every hook passes the event through unchanged.

### What each hook does

| Hook | What it does | Changes anything? |
| --- | --- | --- |
| `session.start` | Registers the `/progress-bar` command | No |
| `command.run` (`/progress-bar` only) | Answers that one command by toggling the bar's visibility; every other command passes by | Only answers its own command |
| `prompt.submit` | Starts a new task when a person (terminal, Remote Control, SDK, scheduled task) submits a prompt; notifications and agent hand-backs continue the current one | No: the prompt passes through unchanged |
| `turn.start` | Marks the task as working and reads the session's agent list | No |
| `tool.call` | Counts every tool call and, after it, reads the session's agent list; for `TodoWrite`, `TaskCreate` and `TaskUpdate` it reads the input and result to track items | No: calls, inputs and results pass through unchanged |
| `agent.spawn` | Records each subagent that starts (its type, description and parent) | No: the spawn, its prompt and its model pass through unchanged |
| `turn.complete` | Marks a subagent or the main turn as finished and records the total time | No: the answer passes through unchanged |
| `ui.render` (`AbovePrompt`) | Draws the bar above the prompt | Draws only its own band |

## Commands

- `/progress-bar` shows or hides the bar.

## Files

| Path | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | The manifest |
| `.claude-plugin/marketplace.json` | Makes this repository its own marketplace, for `/plugin install` |
| `.claude-plugin/icon.png` | The listing icon |
| `hooks/hooks.json` | Points Claude Code at the mod's hooks module |
| `hooks/register.tsx` | The mod: every hook and the bar's drawing |
| `types/index.d.ts` | The mod's state contract |
| `tests/progress.test.ts` | Tests, run with `claude plugin test .` |

### Why `plugin.json` has a `types` field

`types` names `types/index.d.ts`, the contract that declares the session state this mod keeps: `progress-bar.progress` (the task's todos, tasks, agents and counts) and `progress-bar.isHidden` (whether `/progress-bar` hid the bar). Claude Code's mod engine holds every state key a mod reads or writes to that contract, so `claude plugin validate` fails without it:

```
✘ progress-bar.isHidden is not declared: the manifest's types contract must name it …
✘ progress-bar.progress is not declared: the manifest's types contract must name it …
```

Validators that check only the general plugin manifest schema may report `types` as an unrecognized field. That warning can be ignored: the field is required for this mod and changes nothing else about how the plugin loads.

## License

MIT, see [LICENSE](LICENSE).

## Develop

```
claude --plugin-dir .            # run a session with this folder loaded
claude plugin validate .
claude plugin test .
```
