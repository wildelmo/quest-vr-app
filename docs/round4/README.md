# Round four: more to do with the lotus, the lanterns and the fireflies

Integrated into the branch in commit e5cd625 (on top of 0d5c77d): six hand-tracked interactions —
**lantern-nudge** (an open hand meets a floating lantern instead of passing through it), **lotus-lean**
(a closed bud leans toward a fingertip and opens under a patient one), **lantern-lotus** (a lantern set
down among the lily pads warms a bud open), **firefly-escort** (fireflies ride up with a released
lantern, and the lake passes the new star on as a wave of flashes), **firefly-ribbon** (fireflies string
out behind a slow open hand) and **hush** (a palm resting flat on the water stills a circle of it).

The features themselves are documented where everything else is: the interaction table, ctx notes,
visual and sound sections of `DESIGN.md`, the "what to do" line of `README.md`, and the 36-step
scenario in `tools/harness/scenario.mjs`. Nothing in this folder is loaded by the app; it is kept for
reference.

## What is here

- `api-map.md` — the API map of the codebase at 0d5c77d that the implementers worked from (ctx, hands,
  events, wave sim, lotus/lanterns/fireflies internals, audio helpers, harness).
- `proposals.json` — all 24 proposals from the six design angles; `slate.json` — the six chosen, with
  their implementation specs; `specs/*.md` — the same specs, one file per feature.
- `agent-reports.json` — the implementation agents' structured reports: what was built, where it
  deviates from the spec, and notes for the integrator. Where a spec and a report disagree, the code
  (and the documentation) follow what was built.

The lane patches that used to live in `patches/` were superseded by the integrated commit and removed.
