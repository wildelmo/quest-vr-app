# Round four: more to do with the lotus, the lanterns and the fireflies

Work-in-progress snapshot taken before a session limit. Nothing in this folder is loaded by the app;
it exists so the round can be resumed without redoing the design and implementation agents' work.

## What is here

- `api-map.md` — exact API map of the codebase at commit 0d5c77d (ctx, hands, events, wave sim,
  lotus/lanterns/fireflies internals, audio helpers, harness). Written for implementers.
- `slate.json` — the six chosen features with complete implementation specs; `specs/*.md` is the same
  text one file per feature; `proposals.json` is all 24 proposals from the six design angles.
- `patches/lane-a.patch` — diff from 0d5c77d of lane A: **lotus-lean** (buds lean toward a fingertip,
  patient hover opens them) and **lantern-lotus** (a lantern set among lily pads warms a bud open).
  Committed on the lane as d97f965 with both features; harness PASS, scenario 17/17 in that worktree.
- `patches/lane-b.patch` — diff from 0d5c77d of lane B: **hush** (palm flat on the water stills a
  circle; committed as 0659c9a, harness PASS at 60 draw calls, 11/12 scenario steps, the failing
  `hush-dissolves` is a timing margin: strength was 0.109 after 2.5 s against a 0.10 threshold, so wait
  120 frames or accept < 0.15) plus the **firefly-ribbon** work in progress (uncommitted when snapshotted;
  the agent was mid-scenario).
- `agent-reports.json` — the implementation agents' structured reports (deviations, integrator notes).

## Not started when snapshotted

- **lantern-nudge** (open hand physically pushes a floating lantern) — `specs/lantern-nudge.md`.
- **firefly-escort** (fireflies ride up with a released lantern; lake-wide flash wave when the star is
  born) — `specs/firefly-escort.md`. Must be built last, on top of the ribbon (shares fireflies.js
  state numbers: ESCORT = 4, FOLLOW = 5).
- Integration, adversarial review, DESIGN.md / README / HUD updates.

## How to resume

```
git checkout -b r4/lane-a && git apply --index docs/round4/patches/lane-a.patch
git checkout claude/webxr-vr-quest-app-xxnrf2 && git checkout -b r4/lane-b && git apply --index docs/round4/patches/lane-b.patch
```

Merge lane B into lane A (conflicts are confined to src/main.js event list and stats(), src/world/hints.js
appended hints, src/audio/sfx.js handlers, src/world/index.js registry and tools/harness/scenario.mjs; keep
both sides). Intended scenario order: calibrated + lantern steps -> lantern-nudged -> lotus-leans /
lotus-patient-open (before lotus-bloomed) -> lantern-warms-lotus -> firefly-landed -> escort steps ->
ribbon steps -> hush steps -> locomotion and leave. Then build nudge and escort, run
`node tools/harness/run.mjs` and `node tools/harness/scenario.mjs` (run one at a time: two software-rendered
Chromium instances on four cores slow each other tenfold), review, document, squash onto the branch.
