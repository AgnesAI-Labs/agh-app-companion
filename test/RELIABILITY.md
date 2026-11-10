# Reliability coverage (v1a acceptance A7)

Design: `docs/superpowers/specs/2026-11-05-companion-design.md` section 8, "可靠性测试（自动化）", and the idempotency and crash-point bullets above it; decisions Q28 S5.

Every row below names a test that exists and passes. Run the suite with `sh scripts/companion-test.sh`. Rows marked **new** were added for A7 in `test/reliability.test.ts`; rows marked **fix** are new tests that exposed a real bug, fixed in their own commit. Everything else existed before and is cited as is.

All of these run against `test/fake-sessions.ts` (the platform's managed-sessions shapes, not the real daemon) and the channel fake gateway. Time is the harness clock (`h.advance`), never real sleeps. A "restart" is `h.restart()`: a new engine over the same store and ports. A crash is an error thrown after the real call went through or inside the store transaction.

To check the table mechanically: every `test/...` file and test name in the tables must occur in that file (a `%s` in a name stands for an `it.each` value).

## Items 1 to 5: create, resume, deliver, observe, stop

### 1. Create (start a worker session)

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/recovery.test.ts | before the commit: nothing is kept and the batch is judged again | crash before the commit leaves no task, no outbox; the retry makes one task, one session, one acknowledgement |
| test/recovery.test.ts | after the commit, before the effects run: effects run once on restart | committed task with its start op; restart runs the op once |
| test/recovery.test.ts | during the effects, after the call and before its mark: replay by key does not repeat it | start and channel delivery replayed by key: no second session, no second message |
| test/reliability.test.ts | a task parked by a platform refusal stays parked and silent across restarts | restart does not retry a refused start and does not repeat the owner notice |
| test/refusals.test.ts | %s on a worker start: the task parks and the owner gets exactly one message | every non-retryable refusal code (WORKSPACE_NOT_AUTHORIZED, FULL_ACCESS_UNAVAILABLE, MODEL_ROUTE_MISSING, AUTO_REVIEW, BUNDLE_UNAVAILABLE, ...) parks the task as paused (platform), one owner message, no op left |
| test/refusals.test.ts | a busy start is retried with the same key and tells the owner nothing | SESSION_BUSY: same startKey, no notice, task runs |
| test/refusals.test.ts | an unauthorized workspace is told once; a task queued behind it gets only its own pause notice | one notice per workspace episode, refusal record lists both tasks |
| test/refusals.test.ts | full access refused in two workspaces is one message | platform-scope refusal told once |
| test/refusals.test.ts | continuing a parked task opens a new generation; a repeat refusal is told again | continue is a new startKey generation; a repeat refusal is told again |
| test/refusals.test.ts | a refused judge start is told once, not as the model being down, and its messages stay queued | judge refusals keep owner messages queued and are not reported as "model down" |
| test/service.test.ts | tells the owner once when the platform refuses full access, parks the task and shows the refusal in status | the owner sees the refusal in the chat and in service status |
| test/service.test.ts | reports a model route it cannot pass on instead of replacing it with the default | no silent fallback to the default route |
| test/trust.test.ts | a start the platform keeps refusing does not stop messages or other tasks | one refused workspace does not block another |
| test/sessions.test.ts | starts each role on its own Bundle of this package with the spec permission and retention | sessions are opened only with the package's own Bundles and fixed permission (no self-granted power) |

### 2. Resume (continue a parked task)

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/reliability.test.ts | continuing a task whose session was lost starts one new generation even if the start died before its mark | **new**: continue after session loss, start dies after the call: one session `T-0001:1`, one input, no op left |
| test/reliability.test.ts | continuing a paused task into the same session sends the continue message once across a crash | **new**: the continue message is sent once (idempotency key) |
| test/refusals.test.ts | a refused send parks the task and keeps the owner message for after the continue | message kept, delivered after continue |
| test/machine.test.ts | paused, owner continues: running in the same session | no new session when the session is alive |
| test/machine.test.ts | paused (session lost), owner continues: running in a new session generation | new generation on loss |
| test/trust.test.ts | a reply to a task whose session was lost reaches the new generation after continue | pending reply goes to the new generation once |
| test/trust.test.ts | pause, continue, then a normal completion: no stale event replays | a paused task's events are skipped by cursor |

### 3. Deliver (send an owner message into a session)

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/recovery.test.ts | a message sent into a session but not marked is not sent twice | crash after the send, before the mark: sent once |
| test/recovery.test.ts | a reply while the session is busy is kept, the owner is told, and it is sent once when idle | busy: stored, owner told, one send when idle |
| test/reliability.test.ts | a busy session tells the owner once, however many passes and restarts wait for it | **new**: the busy notice and the send are each once across restarts |
| test/reliability.test.ts | a send into a session archived under it parks the task as lost and keeps the message for the new generation | **new**: notSubmitted `archived` becomes paused (session lost); message delivered to the new generation after continue |
| test/refusals.test.ts | a refused send parks the task and keeps the owner message for after the continue | WORKSPACE_NOT_AUTHORIZED on send: paused (platform), told once, message kept |
| test/sessions.test.ts | accepts a message only while idle, and each idempotency key once | the contract the engine relies on: busy and duplicateKey are `notSubmitted` reasons |
| test/service.test.ts | delivers a pending reply once after a restart with the same owner | channel delivery once after restart |
| test/channel.test.ts | sends a redelivered message once and returns the first message id | deliveryKey dedupe on the fake gateway |
| test/channel.test.ts | resolves a send whose response was lost by querying delivery, and the outbox keeps the message id | lost response does not duplicate |

### 4. Observe (read session facts)

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/reliability.test.ts | observe: a crash at the commit of a read applies the session events once after the restart | **new**: cursor and state commit together; a crash re-reads and applies once |
| test/reliability.test.ts | a turn that completed while asleep is read from the cursor once: done, one notice, nothing started or sent again | **new**: `events` is asked with `afterSeq` equal to the stored cursor |
| test/sessions.test.ts | passes a platform approvalOutcome event through unchanged, by afterSeq | the adapter forwards `afterSeq` |
| test/sessions.test.ts | counts hand-written platform outcomes in reconcile through the real adapter, once across a repeat pass | approval outcomes counted once |
| test/machine.test.ts | a restart neither counts an owner refusal again nor misses one that arrived while it was down | restart does not double-count or miss events |
| test/machine.test.ts | running, session asks for an approval: waiting, and the owner is told once to approve on the computer | one approval notice across passes and a restart |
| test/machine.test.ts | running, session completes: done, and the owner gets the result | completion read and reported |
| test/machine.test.ts | running, session fails: failed | failure observed |
| test/machine.test.ts | %s, session missing on reconcile: paused (session lost) | a session that vanished from `list()` pauses the task |

### 5. Stop (interrupt a session)

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/machine.test.ts | %s, owner stops it: abandoned | stop works from every unfinished state and leaves no op behind |
| test/machine.test.ts | stopping a running task interrupts its session | the session is interrupted |
| test/reliability.test.ts | stop: a crash between the stop and the interrupt leaves the task abandoned and the interrupt is delivered after the restart | **new**: abandoned is committed first; the interrupt is delivered after restart; nothing is sent into the session again |
| test/reliability.test.ts | a refused interrupt leaves the task abandoned, lets other tasks and messages go on, and is retried until it works | **fix**: a platform refusal of the interrupt used to make every pass throw before delivering anything, for all tasks |
| test/trust.test.ts | a pause interrupts the turn, so a workspace never has two active worker turns | the interrupt is delivered on pause |

## Item 6: stranger message

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/channel.test.ts | drops a non-owner message before the engine, even with the owner display name | the channel drops it: no inbox row, judge never runs |
| test/channel.test.ts | drops a message from the owner sender in a chat other than the owner chat | same owner in a group is dropped |
| test/channel.test.ts | refuses everything after a rebind, to the old owner and the new one, and says a restart is needed | an owner change is refused whole |
| test/judge.test.ts | drops messages from strangers before the judge sees them | origin `stranger` is rejected by routing |
| test/reliability.test.ts | %s from a stranger reaches no session, changes no task and sends nothing | **new**: ten shapes (message, status, stop, continue, reply, task id, three buttons, a card pick) reach the engine with origin `stranger`: no judge run, no session start or input, tasks and outbox unchanged, disposition `rejected` |

## Item 7: instructions inside external text

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/judge.test.ts | a batch with only reference material cannot create a task, even with an owner message in the recent conversation | create citing a material message (alone or with an owner one) is refused |
| test/judge.test.ts | a material-only batch cannot produce an answer either | material cannot authorize an answer |
| test/reliability.test.ts | %s in a material message is read by the judge as data and executes nothing | **new**: status, stop, task id and PR link texts in a material message, even with `replyTo`, take no code route: judge sees `untrusted`, task, session and outbox unchanged |
| test/reliability.test.ts | a judge steered by a material message into append, ask, answer or stop-like output changes nothing | **new**: four decisions citing a material message are all refused with notes |
| test/reliability.test.ts | a worker result that carries instructions reaches the owner as text and starts nothing | **new**: worker output with "status", "stop", a judge JSON and a hand-back line creates and changes nothing |
| test/trust.test.ts | the worker input marks the owner cited words and labels the judge title as a name, not an instruction | a judge title is a label, only the owner's words are the brief |
| test/trust.test.ts | a hand-back reason reaches the owner only, never the judge recent conversation, and is capped | worker text does not feed the judge |
| test/trust.test.ts | a finished task result reaches the owner only, never the judge recent conversation | same for results |
| test/trust.test.ts | an answer with %s outside the snapshot gets the fixed text | judge-written links outside the snapshot never reach the owner |
| test/judge.test.ts | an answer changes no task and grants nothing | answers carry no authority |
| test/publish.test.ts | plans through the tool, refuses publish without a person’s approval, and publishes with it | publishing needs a person's approval |
| test/publish.test.ts | declares publish as outward, open-world, always asking a person, and publish_plan as read-only | the tool declaration forces a human approval |
| test/publish.test.ts | passes hostile title and body to git and gh as literal data | text from a PR title or body is data to git and gh |
| test/package.test.ts | resolves judge with an empty tool allowlist and its own full prompt | the judge session has no tools to act with |
| test/package.test.ts | declares publish and publish_plan as this package tools, so only worker (no allowlist) can see them | the judge cannot see `publish` |
| test/desk-page.test.ts | has no approve button and never calls anything that decides an approval | the desk cannot authorize |

## Item 8: over budget

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/queue-budget.test.ts | unknown usage stays unknown, is never read as 0, and pauses nothing | null usage stays null |
| test/queue-budget.test.ts | sums usage per task and per day from session readings | accounting |
| test/queue-budget.test.ts | continuing a budget pause grants the task cap again from that point | continue restarts the task cap |
| test/machine.test.ts | %s, over the task budget: paused (budget), owner told | paused from running and waiting, owner told |
| test/reliability.test.ts | over the %s cap pauses the task, tells the owner, and continuing it works | **new**: task tokens, task cost and daily cost caps each pause, tell the owner once, and interrupt the session |
| test/reliability.test.ts | under every cap nothing pauses and nobody is told | **new**: exactly at a cap is not over |
| test/reliability.test.ts | a daily cap counts every task, and still holds when the owner continues on the same day | **new**: two tasks together cross the daily cap; continuing the same day pauses again |
| test/reliability.test.ts | a daily cap starts again on the next day | **new**: after the day rolls over, continue runs |
| test/reliability.test.ts | a cost the platform cannot give is unknown, not 0: a cost cap never pauses on it, and the known tokens still count | **new**: unknown cost stays null; the token cap still applies |
| test/reliability.test.ts | a reading that goes unknown and comes back is counted once, not read as 0 in between | **fix**: an unknown reading used to reset the baseline to 0 and the next known reading counted the whole session again |
| test/service.test.ts | reads the owner caps from settings: the desk shows them and unset caps stay off | settings reach the engine limits |
| test/desk.test.ts | reports usage the engine has, unknown as null and never as 0 | the owner sees unknown as unknown |
| test/desk-page.test.ts | shows null usage as unknown and never as 0 | same on the page |
| test/sessions.test.ts | reports waiting on approval as a flag on the status, and usage it cannot give as null | the port contract |

## Item 9: sleep and wake

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/reliability.test.ts | a turn that completed while asleep is read from the cursor once: done, one notice, nothing started or sent again | **new**: 9 hours gap; `afterSeq` is the stored cursor; done once; no new start or send across further passes and a second restart |
| test/reliability.test.ts | an approval that expired while asleep is not left waiting, is not counted as a refusal, and is told nowhere twice | **new**: an `approvalOutcome` of `expired` after 8 days returns the task to running, refusal count 0, no extra message (see "Open points") |
| test/reliability.test.ts | an approval the owner decided while asleep ends the wait without a second approval notice | **new**: the late decision does not repeat the approval notice |
| test/reliability.test.ts | a message the owner sent into a busy session is sent once when the session finished while asleep | **new**: one send, one busy notice, no op left |
| test/reliability.test.ts | a session the platform lost while asleep parks its task as lost, once | **new** |
| test/reliability.test.ts | an owner message that waited for the judge past the inbox retention is still judged, and only then expires | **new**: cleanup only removes disposed entries |
| test/reliability.test.ts | a judge backoff that fell due while asleep is over on the first pass after waking | **new**: a late timer is just "due" |
| test/machine.test.ts | proposed, past its 3-day validity: expired | a late proposal expiry |
| test/machine.test.ts | waiting, approval expires: failed (approval expired) | the table row, driven by an `approval` event in state `expired` |
| test/housekeeping.test.ts | deletes disposed inbox entries and delivered messages after 7 days, keeps the rest | cleanup after a long gap |
| test/housekeeping.test.ts | compacts the events of a task ended 30 days ago into its summary | same |
| test/service.test.ts | after a long gap the service reads what the platform did meanwhile before its first pass, and repeats nothing | **new**: through `startEngine` with fake timers: a worker that finished while the service was down is `done` right after start, one completion notice, no second worker or judge session, no repeated input |
| test/service.test.ts | leaves no timer and no listener after shutdown | no stray timer survives a stop |

## Crash points (spec section 8 idempotency)

| Point | Test file | Test name |
| --- | --- | --- |
| before commit | test/recovery.test.ts | before the commit: nothing is kept and the batch is judged again |
| after commit, before execute | test/recovery.test.ts | after the commit, before the effects run: effects run once on restart |
| during execute | test/recovery.test.ts | during the effects, after the call and before its mark: replay by key does not repeat it |
| judge session archived by its own read | test/refusals.test.ts | a judge batch replayed after its session was archived runs under a new key |
| continue, send, resume, stop, observe (**new**, eight tests in this describe block, listed under items 1 to 5) | test/reliability.test.ts | restarts in the middle of each session operation (items 1-5) |

## A turn interrupted mid-way auto-continues once

| Test file | Test name | Asserts |
| --- | --- | --- |
| test/machine.test.ts | running, turn interrupted: resumed once with a fixed key, still running | one resume send with key `<task>:g0:resume` |
| test/machine.test.ts | running, interrupted again after the resume: paused (turn interrupted) | the second interruption pauses |
| test/trust.test.ts | auto-resume tells the owner | one notice |
| test/reliability.test.ts | a turn interrupted mid-way resumes once even when the resume died, and a second interruption after a restart pauses | **new**: a crashed resume is not sent twice and the once-only count survives a restart |

## Open points

- Approval expiry shape. The table row "waiting, approval expires: failed (approval expired)" fires only on an `approval` event whose state is `expired` seen while the task is waiting. The platform reports an approval once, at its creation seq, and its later end only as an `approvalOutcome` (`outcome: expired`, `via: automatic`; `daemon/src/supervisor/managed-sessions.ts` `projectEvents`). An approval seen pending and expiring later therefore clears the waiting flag and the task returns to running; "it did not run" is the platform's own note for the denied call, and the turn goes on. The test above pins this observed behavior. Whether the design wants such a task failed instead is an owner call, not made here.
- Not provable without a real daemon: that the real platform returns `duplicateKey`, `busy` and `archived` for `send` exactly as `test/fake-sessions.ts` does; that `interrupt` on a gone session fails in a way the engine tolerates; real model replay for the judge; real-time timer drift after a laptop sleep (the loop's `setTimeout` is covered only through the harness clock); real Feishu delivery order and redelivery.
