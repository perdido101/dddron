# BUZZKILL

Browser-based asymmetric multiplayer party game. One player flies a badly-behaved
toy drone whose battery is a bomb fuse; everyone else races to build an EMP from
power cores that sit on the pads the drone needs to recharge.

Publisher: WildBox. Built to the BUZZKILL Claude Code Build Brief, one phase at a time.

## Status

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Scaffold, fixed-step Rapier, debug overlay | done |
| 1 | Runner controller + grey-box arena | done — feel gate passed |
| 2 | Drone controller | **done — awaiting FEEL GATE playtest** |
| 3–11 | Fuse loop, EMP, netcode, lobby, hazards, art, deploy | not started |

Phases 1 and 2 each end in a feel gate. Nothing past a gate gets built until a
human has played it, because everything downstream is worthless if the gates
fail. Phase 2 is the highest-risk phase in the project: flying has to be
funny-bad, not frustrating-bad, and that is not something a test can assert.

## Play it

**https://perdido101.github.io/dddron/**

Published from this branch by `.github/workflows/playtest.yml` on every push, so
the feel gates can be played from a link. Typecheck gates the deploy. This is a
playtest harness for the static client only — the real deploy work (Colyseus
host, environment-based server URL, room cleanup, telemetry) is phase 11.

Click the canvas to capture the mouse.

## Running it locally

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
| WASD | Move (runner: relative to camera; drone: relative to its own facing) |
| Space | Jump / drone climb |
| Shift | Drone descend |
| Mouse | Look (runner) / turn the drone |
| `C` | Swap between piloting the runner and the drone |
| `~` | Debug overlay: fps, physics cost, body count, runner state |
| `O` | Free camera (inspect the arena, or either body, mid-build) |
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

**Drone forces, not velocities.** Sacred constraint 1 forbids ever assigning the
drone's velocity, so everything shaping its handling is a force on a dynamic
body: thrust, the hover force that cancels its own weight, the soft altitude
springs, and a permanent low-frequency wander. Its rigid-body rotation is locked
and the tilt you see is cosmetic, driven by velocity — a freely tumbling
quadcopter makes wall bounces unpredictable and stops reading as comic.

**Intent velocity vs realised velocity.** The runner integrates its own velocity
and hands a desired translation to Rapier's kinematic character controller. The
controller's *returned* movement is deliberately **not** fed back into that
velocity — see the comment in `runner.ts`. Cosmetics (lean, bob, facing) read the
realised value; physics reads the intent.

**Authority, for later phases.** Runner movement is client-authoritative by
design (sacred constraint 5). The server will validate only battery, cores, EMP
state, detonation and elimination. No rollback, no lag compensation.

## Phase 2 verification

Measured by driving the build in a browser. The last criterion is the one that
matters most and is the one no test can settle — hence the gate.

- Top speed reaches 9.03 m/s against the brief's `MAX_SPEED` of 9.0.
- Tilt peaks at 24.8 deg at 8.93 m/s, under the 25 deg `TILT_MAX` cap.
- Wall bonk: approached at 9.04 m/s, touched z = -29.03, rebounded to -24.31 —
  a 4.72 m bounce.
- Altitude band is soft, not clamped: holding Space overshoots `ALTITUDE_MAX` to
  12.60 before the spring pulls it back; holding Shift dips to 0.90 under the
  1.5 m floor and springs back to 1.8.
- Drift after release: coasts 11.03 m, bleeding 7.96 -> 2.28 m/s. No hard stop.
- Hands-off for 3 s it wanders 1.21 m, so it cannot be parked on a target.
- Prop wash at 0.98 m separation shoves the runner 2.11 m and never harms it.

**Open question for the playtest.** Is it entertaining for two minutes, or
merely difficult? If it reads as frustrating, the levers in order of leverage
are `DRONE_WANDER_ACCELERATION` (how much it fights you at rest),
`DRONE_LINEAR_DAMPING` (how far it coasts — the brief caps this at 0.8), and
`DRONE_ACCELERATION` (how fast it answers the stick).

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

## Bugs found and fixed during phase 2

1. **Rapier's `addForce` is persistent, not per-step.** It keeps applying every
   step until `resetForces` is called, so the hover force compounded each tick
   and the drone reached y = 2.9 million before the WASM panicked with an
   `unreachable` trap. The reset is now the first thing each step does.
2. **Restitution is averaged between colliders by default.** The arena's
   colliders are 0, so `WALL_BOUNCE` of 0.45 was silently halved to 0.225 and
   the bonk barely registered. The drone now uses the `Max` combine rule.
3. **Top speed settled at 5.37 m/s instead of the brief's 9.0.** A smooth
   thrust falloff cannot reach it: at 9 m/s the brief's own damping of 0.6 eats
   5.4 of the 8.0 m/s^2 available. Thrust now cuts out at `MAX_SPEED` and
   resumes below it, which caps speed without assigning velocity.
4. **The drone could be parked.** With only the brief's damping it coasted to a
   dead stop and stayed there, failing both sacred constraint 1 and the phase 2
   criterion that holding a spot be difficult. It now carries a permanent slow
   wander built from two incommensurate sines — deterministic, so clients will
   still agree in phase 5.

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
