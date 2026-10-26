# Jobs

## open_loops.py

The 07:30 open-loops post, kept as a record. It reads the last seven days of Discord messages and every
recorded loop through the Grysstof read API, asks the model which loops closed, moved or are new, checks
each claim in code, writes one `loop:<key>` ledger line per change through `/mcp`, and posts the list.
Plan 5 (`05-open-loops-pa.md`), contracts C1, C2, C3, C5 and C6.

Python 3.11 or later, standard library only.

| Command | What it does |
|---|---|
| `open_loops.py --env FILE --check` | Reads Grysstof, says which settings are set (never their values), compares the clock with Discord's `Date` header (fails above 60 seconds). No model, no writes, no post. |
| `open_loops.py --env FILE` | Dry run: the model pass, then prints `would unpark N`, `would open N, close M, update K`, every line it would write, and the post. Writes nothing, posts nothing. |
| `open_loops.py --env FILE --post` | Writes the ledger lines, then posts to the webhook. |
| `--lock FILE` | Holds this lock for the run. A held lock exits at once; one older than an hour also posts "previous run still holding the lock" (with `--post`). |

A parked loop whose `until` has passed (a bare date counts from 00:00 SAST that day) comes back at the start of
the run: one `OPEN/1` line superseding the `PARKED/1` line, every field carried from the OPEN line before it, read
from `/browse/api/history`. It then takes part in the run like any open loop.

With `--post`, the post is built from a fresh `/loops` read after the writes. A loop someone changed during the
run (a press in the PA) is left as it is and counted as a conflict; that alone does not fail the run.

Time limits: 30 s on every Grysstof, Discord and webhook call; 120 s of silence on the streamed model call; 780 s
for the reads, the model call and the writes together, so the cron line's `timeout 900` never cuts a run off
mid-write. SIGTERM runs the failure path (one line, and a post with `--post`). A write that times out is never
sent again: the job waits 10 s, reads the loop once, and reports the write as unknown if it is not there yet. A
line that supersedes nothing (a new loop) is never sent twice. A webhook 429 waits for Discord's `retry_after`.

Exit codes: 0 done (conflicts alone included); 1 a failure, a write that failed, timed out unknown or was not
made before the deadline (one line on stderr, and in the channel with `--post`); 2 settings; 3 lock held.

### Env file

Stays outside the repo (`/home/corical/open-loops/.env`, chmod 600), passed with `--env`. `server/jobs/.env*` is ignored by git.

| Key | Meaning |
|---|---|
| `OPEN_LOOPS_MODEL_PROVIDER` | Which model provider answers `ask(system, user)`. Default `anthropic`, the only one today. |
| `OPEN_LOOPS_MODEL` | The model id for that provider. Default `claude-sonnet-5-5`. |
| `ANTHROPIC_API_KEY` | Model calls, when the provider is `anthropic`. |
| `OPEN_LOOPS_WEBHOOK` | Where the post goes. Needed with `--post`. |
| `GRYSSTOF_URL` | The server's `/mcp` URL, e.g. `http://localhost:8788/mcp`. `/browse/api` is read from the same base. |
| `MCP_ACCESS_KEY` | Sent as `x-brain-key`. |
| `XACTCO_MEMBERS` | Comma-separated Discord user ids of Xactco people; only their replies close a loop. Each may carry a name, `id:Name`, used only for messages captured before the bot stored author ids. |

### Cron (Pi)

```
30 7 * * 1-5 timeout 900 python3 /home/corical/grysstof/repo/server/jobs/open_loops.py --env /home/corical/open-loops/.env --lock /home/corical/open-loops/.lock --post >> /home/corical/open-loops/run.log 2>&1
```

The script takes the lock itself. `flock -n` in front of it would stop a second run before the script starts, so
nothing could post that a run is stuck. Do not put `flock` on the same file in front of `--lock`: the script
would always find it held.

### Tests

From the repo root: `python3 -m unittest discover -s server/jobs -p "test_*.py"`. No network: every call goes to a
fake. `fixtures/` holds a recorded window, the transcript it must produce, a model answer in the C5 shape and a
`/loops` reply. `server/tests/fixtures/c1-sanitise.json` (written by the core) is read too: the job's C1 sanitiser
must give the same output as `core/loops.ts` for every case; the test skips, with a message, while the file is absent.
