# BUZZKILL — Claude Code Build Brief
**Publisher:** WildBox
**Working title:** BUZZKILL (swappable — alternatives: FUSE, LAST CHARGE, 0%)
**Type:** Browser-based asymmetric multiplayer party game, 3D
**Target session:** 5–7 rounds × 3 minutes, 3–8 players, friends-only lobbies

---

## 0. READ THIS FIRST

This brief is executed **sequentially, one phase at a time**. Do not skip ahead. Do not
build features from later phases "while you're in there." Each phase has an
**acceptance criteria** block — the phase is not done until every line passes, verified
by actually running the build, not by reading the code.

Two phases are marked **FEEL GATE**. At a feel gate, stop and hand the build back for
playtesting before continuing. If a feel gate fails, we retune rather than proceed.
Everything downstream is worthless if the gates fail.

---

## 1. CONCEPT

An arena is locked down. A hostile **toy drone** — piloted by one human player — patrols
it. The drone's battery *is* a bomb fuse: when it hits 0% it detonates, killing every
runner within blast radius, then respawns at a charge pad with a **shorter fuse than
last time**.

The runners (everyone else) must build and fire an **EMP** to permanently kill the drone.
The EMP needs power cores. The power cores sit on the **same charge pads the drone needs
to recharge**. That contested resource is the entire game.

**Runners win** the moment the EMP fires.
**Drone wins** if all runners are eliminated, or the 3-minute round timer expires.

The comedy is that the drone is *bad at flying*. It drifts, overshoots, bounces off walls
and gets tangled in hazards. It is a delivery system with terrible handling, not an
assassin.

---

## 2. TECH STACK — FIXED, DO NOT SUBSTITUTE

| Layer | Choice |
|---|---|
| Language | TypeScript (strict) |
| Build | Vite |
| Rendering | Three.js (r160+) |
| Physics | Rapier (`@dimforge/rapier3d-compat`, WASM) |
| Netcode | Colyseus (server + `colyseus.js` client) |
| Server runtime | Node 20+ |
| State schema | `@colyseus/schema` |
| Audio | Howler.js |
| Deploy target | Static client (Vercel) + Colyseus node host |

Monorepo layout:

```
/client    — Vite + Three.js + Rapier (client prediction only)
/server    — Colyseus rooms, authoritative game state
/shared    — constants, types, schema definitions (imported by BOTH)
```

**All tuning constants live in `/shared/constants.ts`.** No magic numbers anywhere else in
the codebase. This file is the tuning surface for the entire game.

---

## 3. SACRED CONSTRAINTS

These are not suggestions. Violating any of them breaks the game's core design.

1. **The drone can never stop instantly.** It always carries momentum. Release of input
   produces drift, never a hard stop. Drag is applied, but linear damping must stay below
   `0.8`. If the drone can hover precisely on a target and hold position, the game is dead.
2. **The drone cannot choose when to detonate.** Detonation is purely a function of
   battery reaching zero. There is no manual trigger, ever.
3. **Battery state is server-authoritative and is the single source of truth.** The client
   renders it; it never computes it.
4. **Knocking the drone down never kills it.** It forces an early return to a charge pad.
   The reward for counterplay is *time*, not victory.
5. **Runner movement is client-authoritative.** This is a friends game, not ranked. Do not
   build rollback, lag compensation, or server-side movement simulation. The server
   validates only battery, cores, EMP state, detonation and elimination.
6. **Every objective action must be slow, loud, and co-located.** If a runner can complete
   an objective alone, quickly, and safely, the objective is wrong.

---

## 4. TUNING CONSTANTS (initial values — put these in `/shared/constants.ts`)

### Arena
```
ARENA_SIZE            60 × 60 m, walled, ceiling at 14 m
CHARGE_PAD_COUNT      3   (triangular spread, none within 15 m of another)
EMP_STATION_COUNT     1   (arena centre)
```

### Runner
```
RUN_SPEED             6.0 m/s
CARRY_SPEED           4.5 m/s     (while holding a power core)
JUMP_IMPULSE          7.0
CAPSULE               radius 0.5, height 1.8
COYOTE_TIME           0.12 s
```

### Drone
```
MAX_SPEED             9.0 m/s
ACCELERATION          8.0 m/s²
LINEAR_DAMPING        0.6         (HARD CAP 0.8 — see sacred constraint 1)
TILT_MAX              25°         (visual tilt follows velocity)
ALTITUDE_MIN          1.5 m
ALTITUDE_MAX          12.0 m
WALL_BOUNCE           0.45 restitution
PROP_WASH_RADIUS      3.0 m       (pushes runners, does not damage)
PROP_WASH_FORCE       12.0
```

### Battery / fuse
```
FUSE_BY_CYCLE         [60, 45, 35, 28, 22] s   (index 5+ clamps to 22)
DETONATION_RADIUS     4.0 m
TELEGRAPH_TIME        3.0 s       (last 3 s: drone flashes red, prop pitch rises)
RECHARGE_TIME         8.0 s       (drone immobile + vulnerable on pad)
KNOCKDOWN_RECOVERY    6.0 s       (grounded, then must fly to a pad)
PROP_AUDIBLE_RADIUS   15.0 m      (volume + pitch scale with distance)
```

### EMP objective
```
CORES_REQUIRED        3
CORE_INSERT_HOLD      3.0 s       (interrupted if runner moves or is hit)
EMP_CHARGE_TIME       20.0 s      (after 3rd core inserted)
EMP_CHARGE_MIN_PRESENT  1 runner if ≤2 alive, else 2 runners simultaneously
EMP_DRAIN_ON_ABANDON  charge decays at 50% of fill rate when unattended
```

### Round / match
```
ROUND_TIME            180 s
ROUNDS_PER_MATCH      max(5, playerCount)
SCORE_RUNNER_SURVIVE  1
SCORE_EMP_FIRED       3   (to every runner alive at fire time)
SCORE_DRONE_ELIM      2   per elimination
SCORE_DRONE_WIPE      5   bonus
```

---

## 5. PHASES

---

### PHASE 0 — Scaffold

**Goal:** Empty but correct project skeleton.

**Tasks**
- Monorepo with `/client`, `/server`, `/shared`, npm workspaces.
- Vite + TypeScript strict in `/client`. Three.js scene, perspective camera, orbit
  controls (debug only), hemisphere + directional light, ground plane.
- Rapier WASM initialised and stepping at fixed 60 Hz with an accumulator. Rendering
  interpolates between physics steps.
- `/shared/constants.ts` populated with every value from section 4.
- Debug overlay: FPS, physics step time, body count. Toggle with `~`.

**Acceptance criteria**
- [ ] `npm run dev` serves a lit 3D scene at a stable 60 fps
- [ ] A dropped Rapier cube falls, lands, and comes to rest on the ground plane
- [ ] Physics remains stable when the tab is backgrounded for 30 s and refocused
- [ ] Zero TypeScript errors under strict mode

---

### PHASE 1 — Runner controller + grey-box arena  🔒 **FEEL GATE**

**Goal:** Moving a runner around must feel good with zero art and zero enemies.

**Tasks**
- Third-person runner: Rapier kinematic character controller, capsule body.
- Camera: follow rig, slight lag, collision-aware (pulls in near walls).
- Movement: WASD relative to camera, jump with coyote time, air control at 60% of
  ground control.
- Grey-box arena at full `ARENA_SIZE`: perimeter walls, 3 charge pad markers, 1 EMP
  station marker, plus ramps, a raised platform, two pillars and one low tunnel.
- Chunky proportions from the start — capsule with a big head sphere. Squash on landing,
  stretch on jump. This costs nothing and sells the tone immediately.

**Acceptance criteria**
- [ ] Running, turning and jumping feel responsive with no input lag
- [ ] The character never clips through walls or falls out of the arena
- [ ] Camera never ends up inside geometry
- [ ] Landing squash and jump stretch are visible and satisfying
- [ ] **STOP HERE.** Hand back for playtest before Phase 2.

---

### PHASE 2 — Drone controller  🔒 **FEEL GATE**

**Goal:** Flying the drone must be funny-bad, not frustrating-bad. This is the highest-risk
phase in the project.

**Tasks**
- Drone as a Rapier dynamic rigid body. Thrust applied as force, never velocity assignment.
- Controls: WASD for horizontal thrust, Space / Shift for altitude, mouse for facing.
- Visual tilt driven by current velocity, capped at `TILT_MAX`.
- Wall and ceiling bounce with restitution — it should visibly *bonk*.
- Altitude clamped between `ALTITUDE_MIN` and `ALTITUDE_MAX` with soft spring resistance
  at the boundaries, not a hard clamp.
- Prop wash: continuous radial impulse on any runner inside `PROP_WASH_RADIUS`, falling
  off with distance. Pushes only — never damages.
- Free camera toggle so both runner and drone views can be inspected in the same build.

**Acceptance criteria**
- [ ] The drone drifts noticeably after input release and cannot hold a precise position
- [ ] Wall collisions produce a visible, comedic bounce
- [ ] It is *possible but difficult* to hover near a specific spot for 3 seconds
- [ ] Prop wash visibly shoves a runner without killing them
- [ ] Flying it for 2 minutes is entertaining rather than annoying
- [ ] **STOP HERE.** Hand back for playtest before Phase 3.

---

### PHASE 3 — Battery, detonation, respawn cycle (single-player)

**Goal:** The fuse loop, locally, with one runner and one drone in the same build.

**Tasks**
- Battery drains over `FUSE_BY_CYCLE[cycle]`. HUD shows a percentage readout visible to
  **all** players — this is public information, deliberately.
- Telegraph: final `TELEGRAPH_TIME` seconds trigger red pulsing on the drone body,
  rising prop pitch, and a HUD warning.
- Detonation: sphere overlap query at `DETONATION_RADIUS`. Any runner inside is
  eliminated. Confetti-style particle burst — bright, celebratory, not gory.
- Post-detonation: drone falls to the ground, is inert for 2 s, then flies at reduced
  speed until it docks at a charge pad. `RECHARGE_TIME` docked and immobile, then relaunch
  with `cycle + 1`.
- Positional audio for prop whine across `PROP_AUDIBLE_RADIUS`, with volume and pitch
  scaling by distance. **This is a core mechanic, not polish** — runners must be able to
  locate the drone by ear alone.

**Acceptance criteria**
- [ ] Battery drains at exactly the constant for the current cycle
- [ ] Telegraph is unmistakable both visually and audibly
- [ ] A runner 3 m away dies; a runner 5 m away survives
- [ ] Cycle 2 fuse is measurably shorter than cycle 1
- [ ] With eyes closed, a player can tell whether the drone is approaching or receding

---

### PHASE 4 — Power cores + EMP objective (single-player, dummy drone)

**Goal:** The full runner win condition, playable solo against a scripted drone.

**Tasks**
- 3 power cores, one spawning on each charge pad. Pickup on proximity + hold `E`.
- Carrying: movement drops to `CARRY_SPEED`, core is visibly held overhead, and the
  runner **cannot jump**. Being hit by prop wash drops the core where they stand.
- Contest rule: while a core sits on a charge pad, **the drone cannot dock there**. This
  is the central tension — taking cores denies recharge points, but forces runners into
  the drone's patrol route.
- EMP station: insert a core with a `CORE_INSERT_HOLD` hold that cancels on movement or hit.
- After the 3rd core: `EMP_CHARGE_TIME` charge phase requiring `EMP_CHARGE_MIN_PRESENT`
  runners standing in the station zone. Charge decays when unattended.
- EMP fires → screen-wide white pulse → drone drops dead → **RUNNERS WIN**.
- Simple scripted drone: patrols waypoints, drifts toward the nearest runner within 20 m.
  No pathfinding, no cleverness. It exists only to pressure-test the objective.

**Acceptance criteria**
- [ ] All 3 cores can be delivered and the EMP fired end to end
- [ ] Core carrying is meaningfully risky — slow, no jump, drops on hit
- [ ] The drone genuinely cannot dock on a pad holding a core
- [ ] Charge decays visibly when the station is abandoned
- [ ] A solo run takes roughly 90–150 s against the scripted drone

---

### PHASE 5 — Colyseus: 1 drone vs 1 runner, networked

**Goal:** Two real clients, correct authority split, no desync.

**Tasks**
- Colyseus `GameRoom` with `@colyseus/schema` state: player positions, roles, battery,
  cycle count, core states, EMP progress, round timer, alive flags.
- Client sends position and input state at 20 Hz. Server broadcasts state at 20 Hz.
- Remote entities interpolate between snapshots. Local player is never corrected by the
  server for movement.
- Server owns and validates: battery drain, detonation and its overlap query, core pickup
  and insert, EMP progress, elimination, round timer, win conditions.
- Basic role assignment: first player in is the drone, second is a runner.
- Disconnect handling: if the drone player leaves mid-round, the round ends immediately
  and is not scored.

**Acceptance criteria**
- [ ] Two browser windows show each other moving smoothly
- [ ] Both clients display identical battery percentage at all times
- [ ] Detonation kills the correct player on both clients simultaneously
- [ ] Core pickup cannot be duplicated by two clients grabbing at once
- [ ] Killing the server mid-round does not corrupt the client, it shows a clean error

---

### PHASE 6 — Lobby, room codes, N runners

**Tasks**
- Landing screen: nickname entry, Create Room, Join with 4-letter code.
- Lobby: player list, ready toggles, host-only start. Host can force role assignment for
  round 1; after that rotation is automatic (Phase 9).
- Support 3–8 players: 1 drone, 2–7 runners.
- Scale objective difficulty by runner count: `EMP_CHARGE_MIN_PRESENT` becomes 2 when 3+
  runners are alive, 1 otherwise.
- Reconnection window of 30 s using Colyseus `allowReconnection`.

**Acceptance criteria**
- [ ] 5 clients can join one room via code and start a round
- [ ] A player refreshing mid-round rejoins in the same role with correct state
- [ ] The lobby cannot start with fewer than 3 players
- [ ] Runner-count scaling of the charge requirement works at 2 and 3 alive runners

---

### PHASE 7 — Hazards and counterplay

**Goal:** Give runners physical answers to the drone. "Make it drop" becomes literal.

**Tasks**
- **Swat:** melee arc on `F` with a 1.5 s cooldown. Hitting the drone within 2.5 m knocks
  it down for `KNOCKDOWN_RECOVERY`, after which it must dock at a pad.
- **Ceiling fans:** 2 in the arena, always on. The drone entering the wash is flung
  violently. Runners are unaffected.
- **Streamer nets:** 3 static hanging obstacles. The drone passing through is slowed 60%
  for 2 s and its props visibly tangle.
- **Throwables:** loose props scattered in the arena, pick up and throw. A direct hit
  knocks the drone down. Physics-driven, deliberately inaccurate.
- **Sabotage pads:** a runner can hold `E` on an empty charge pad for 4 s to disable it
  for 30 s. Slow, loud, and it pins them in a place the drone wants to be.

**Acceptance criteria**
- [ ] Each hazard reliably produces a knockdown or a slow
- [ ] Knockdown always forces a pad return and never kills the drone
- [ ] A coordinated pair of runners can chain hazards to buy roughly 20 s of free time
- [ ] The drone player still wins sometimes against 4 competent runners

---

### PHASE 8 — Elimination and spectator gremlins

**Tasks**
- Eliminated runners become free-flying spectator cameras with a small visible gremlin
  avatar that other players can see.
- **One hazard trigger per detonation cycle:** a gremlin can spawn a throwable, briefly
  reverse a ceiling fan, or drop a smoke puff that blocks drone sight lines. Cooldown
  resets on each detonation.
- Gremlin actions are deliberately **usable to help either side**. This is a feature.
  Do not restrict targeting.
- Spectator UI: who's left, battery, EMP progress, round timer.

**Acceptance criteria**
- [ ] Eliminated players stay engaged rather than sitting idle
- [ ] Gremlin abilities are visible to all players and clearly attributed
- [ ] The cooldown cannot be exploited to spam hazards
- [ ] Gremlins cannot block the EMP station or body-block the drone

---

### PHASE 9 — Match structure, rotation and scoring

**Tasks**
- Match = `max(5, playerCount)` rounds. Drone role rotates so everyone flies at least once
  before anyone flies twice.
- Round-end screen: winner, cause, per-round score breakdown, 10 s auto-advance.
- Running scoreboard using the constants from section 4.
- Final results screen with a match MVP, plus joke awards (most detonations survived,
  most cores dropped, most self-inflicted fan launches).
- Persist scoreboard in room state so a reconnecting player keeps their score.

**Acceptance criteria**
- [ ] A full 5-round match completes without manual intervention
- [ ] Every player pilots the drone exactly once in a 5-player, 5-round match
- [ ] Scores are consistent across every client
- [ ] The winner is meaningfully determined by both runner *and* drone performance

---

### PHASE 10 — Art pass, juice and audio

**Tasks**
- Palette: pastel primaries, soft saturated shadows, no dark or gritty tones. Everything
  reads as oversized plastic toys.
- Runners: chunky capsule bodies, oversized heads, 6 colourways, simple idle/run/carry
  animation. No facial rig — a sticker face is enough.
- Drone: fat plastic quadcopter, chunky rotors, googly-eye sticker on the front, visible
  battery gauge on its body that matches the HUD.
- Materials: soft ambient occlusion, rim light, no PBR realism. Bake wherever possible.
- Juice pass: screen shake on detonation, hit stop on swat connect, confetti bursts,
  camera punch on EMP fire, trailing particles on thrown objects.
- Audio: prop whine layers by RPM, detonation pop, core pickup and insert clicks, EMP
  charge whine rising to the fire, ambient arena hum.

**Acceptance criteria**
- [ ] A screenshot reads as a party game and not a tech demo
- [ ] Detonation feels celebratory rather than punishing
- [ ] The drone's battery state is readable from across the arena without HUD
- [ ] 60 fps holds with 8 players and full particle load on mid-range hardware

---

### PHASE 11 — Deploy

**Tasks**
- Client build to Vercel. Colyseus server to a persistent Node host with WebSocket support.
- Environment-based server URL, no hardcoded endpoints.
- Room cleanup on empty, hard cap on concurrent rooms.
- Basic anonymous telemetry: round outcomes, average round length, drone win rate. This
  data drives the post-launch tuning pass.

**Acceptance criteria**
- [ ] A friend on another network can join via room code with no setup
- [ ] Rooms are disposed when empty
- [ ] Drone win rate is logged and queryable

---

## 6. BALANCE TARGET

After Phase 9, the tuning goal is a **drone win rate of 35–45%** across 5-player rounds.
Below 30% the fuse constants shorten; above 50% either the detonation radius drops or
hazard cooldowns shorten. Tune `FUSE_BY_CYCLE` first — it is by far the highest-leverage
lever in the game.

---

## 7. EXPLICITLY OUT OF SCOPE

Do not build any of the following without a new brief: matchmaking or public lobbies,
progression or unlocks, cosmetics or currency, ranked play, voice chat, mobile controls,
multiple arenas (one arena, tuned properly, first), anti-cheat, rollback netcode.
