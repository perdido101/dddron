# BUZZKILL

Browser-based asymmetric multiplayer party game. One player flies a badly-behaved
toy drone whose battery is a bomb fuse; everyone else races to build an EMP from
power cores that sit on the pads the drone needs to recharge.

Publisher: WildBox. Built to the BUZZKILL Claude Code Build Brief, one phase at a time.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Scaffold, fixed-step Rapier, debug overlay | done |
| 1 | Runner controller + grey-box arena | **done — awaiting FEEL GATE playtest** |
| 2 | Drone controller | blocked on the phase 1 gate |
| 3–11 | Fuse loop, EMP, netcode, lobby, hazards, art, deploy | not started |

Phase 1 ends in a feel gate. Nothing past it gets built until the runner feels
good to a human, because everything downstream is worthless if it does not.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

Other scripts: `npm run typecheck` (all workspaces, strict), `npm run build`
(typecheck + production bundle).

## Controls

| Input | Action |
| --- | --- |
| Click canvas | Capture the mouse (pointer lock) |
| WASD | Move, relative to the camera |
| Space | Jump (coyote time + input buffering) |
| Mouse | Look |
| `~` | Debug overlay: fps, physics cost, body count, runner state |
| `O` | Debug orbit camera (free-look around the arena) |
| `R` | Respawn the runner |
| `B` | Re-drop the phase 0 test cube |

## Layout

```
/client    Vite + Three.js + Rapier. All rendering and local simulation.
/server    Colyseus rooms. Empty until phase 5 — the workspace exists so
           /shared is imported by both sides from the start.
/shared    constants.ts — the tuning surface for the entire game.
```

### /shared/constants.ts

Every tuning value in the game lives there and nowhere else. Constants carry
their brief name; where the brief reused a bare name across sections (`MAX_SPEED`,
`ACCELERATION` and `LINEAR_DAMPING` all sit under "Drone") the name is prefixed
`DRONE_`. Values the brief did not specify are tagged in-file:

- `derived` — computed from a brief value (`CAPSULE_HALF_HEIGHT`, `ARENA_HALF`).
- `unspecified` — a choice that had to be made to build the phase. These are the
  only numbers up for debate, and the notable ones are listed below.

**`GRAVITY = -16.0`** is the one to look at first. The brief fixes
`JUMP_IMPULSE` at 7.0 but names no gravity; at earth gravity that impulse gives a
2.5 m apex and ~1.4 s of hang time, which reads floaty rather than chunky. -16
gives a 1.53 m apex and ~0.88 s airborne.

Other unspecified picks that shape phase 1 feel: `RUN_ACCEL` / `RUN_DECEL`
(60 / 45 m/s²), `JUMP_BUFFER_TIME` (0.12 s), the whole squash/stretch block, the
whole camera block, and the grey-box arena layout (pad positions satisfy the
brief's "triangular spread, none within 15 m of another" — an 18 m circumradius
triangle giving 31.2 m between any two).

## Architecture notes

**Fixed step, interpolated render.** `Physics` advances the Rapier world in whole
1/60 s steps and exposes the leftover fraction as `alpha`; every visible body
holds a previous and current transform and lerps between them, so motion stays
smooth without coupling simulation rate to frame rate. Frame deltas over
`MAX_FRAME_DELTA` are discarded rather than simulated, and a step cap stops a
slow frame from spiralling. This is also why a 30 s tab-away does not replay 30 s
of physics on refocus.

**Intent velocity vs realised velocity.** The runner integrates its own velocity
and hands a desired translation to Rapier's kinematic character controller. The
controller's *returned* movement is deliberately **not** fed back into that
velocity — see the comment in `runner.ts`. Cosmetics (lean, bob, facing) read the
realised value; physics reads the intent.

**Authority, for later phases.** Runner movement is client-authoritative by
design (sacred constraint 5). The server will validate only battery, cores, EMP
state, detonation and elimination. No rollback, no lag compensation.

## Phase 1 verification

Driven through a real browser (Playwright + Chromium), not read off the code.

- Cube dropped from 8.9 m falls, lands at y = 0.40 (its half-extent) and sleeps;
  re-drops on demand and settles again.
- Runner reaches exactly `RUN_SPEED` (6.00 m/s), stops on release, jumps and
  re-grounds.
- Containment: ran into the south wall and the NW corner — rests at ±29.5
  (wall at ±30 minus the 0.5 capsule radius). 50 randomised movement bursts over
  45 s produced zero out-of-bounds samples.
- Traversal: west ramp → ledge lands the capsule centre at y = 3.1 (ledge top 2.2
  + 0.9 foot offset); east ramp → raised platform lands it at y = 3.9 (top 3.0).
  Low tunnel passable end to end.
- Camera: boom holds 7.0 m in the open and pulls to its 1.20 m floor against a
  wall, 2.8 m in the tunnel. Never inside geometry.
- Backgrounded for 30 s and refocused: position finite and unchanged, physics
  resumes at 1 step/frame (no catch-up burst), no console output.
- Zero TypeScript errors under strict mode; production build succeeds.

**Frame rate is the one criterion this environment cannot honestly certify.** The
container has no GPU, so Chromium falls back to SwiftShader software rasterisation
and reports ~11 fps at 1280×720. That number is fill-rate, not game logic:
shrinking the framebuffer to 320×180 takes the frame from 83 ms to 33 ms with
*identical* scene complexity (21 draw calls, 2166 triangles), and the physics step
costs 0.3–0.6 ms per frame. On real hardware this scene should sit at vsync with
enormous headroom, but that needs confirming on your machine — which the feel gate
playtest will do anyway.

## Bugs found and fixed during phase 1

Three defects that all presented identically ("the runner cannot get up a ramp")
and each needed the browser to find:

1. **Ramp slabs offset the wrong way.** Half the slab thickness was added instead
   of subtracted, leaving a 0.45 m lip at every ramp foot — just above the 0.40 m
   autostep, so the ramps were silently walled off.
2. **`CONTROLLER_MIN_SLIDE_SLOPE` was below a ramp's actual slope.** At π/9 (20°)
   Rapier auto-slid the character down the 26.6° east ramp while the shallower
   15.4° west ramp worked fine. Now held equal to `CONTROLLER_MAX_SLOPE`: anything
   climbable is kept.
3. **Feeding controller output back into intent velocity.** On a slope the
   controller legitimately trades horizontal travel for climb; treating that as
   "blocked" decayed the input each step and stalled the runner a metre up every
   ramp. Intent and realised velocity are now separate.
