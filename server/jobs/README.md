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
| `open_loops.py --env FILE` | Dry run: the model pass, then prints `would open N, close M, update K`, every line it would write, and the post. Writes nothing, posts nothing. |
| `open_loops.py --env FILE --post` | Writes the ledger lines, then posts to the webhook. |
| `--lock FILE` | Holds this lock for the run. A held lock exits at once; one older than an hour also posts "previous run still holding the lock" (with `--post`). |

Exit codes: 0 done; 1 a failure (one line on stderr, and in the channel with `--post`); 2 settings; 3 lock held.

### Env file

Stays outside the repo (`/home/corical/open-loops/.env`, chmod 600), passed with `--env`. `server/jobs/.env*` is ignored by git.

| Key | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Model calls. |
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
`/loops` reply.
