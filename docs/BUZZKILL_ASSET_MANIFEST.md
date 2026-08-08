# BUZZKILL — Appendix A: Asset Manifest

**Companion to:** `BUZZKILL_BUILD_BRIEF.md`
**Purpose:** Every non-code asset the game needs, with a named source per item.

---

## HOW TO READ THIS

Each item is tagged with an acquisition route:

| Tag | Meaning |
|---|---|
| **PROC** | Claude Code generates it procedurally. No sourcing needed. |
| **KEN** | Kenney.nl asset pack — CC0, free, already matches the target look |
| **MIX** | Mixamo — free rigged animation, retargeted onto the runner rig |
| **HF** | Higgsfield `generate_3d` — GLB mesh generation |
| **11L** | ElevenLabs sound effects generation |
| **SUNO** | Suno — music only |
| **WEBAUDIO** | Synthesised at runtime in code, not a file |

**Priority column:** `P0` blocks the Phase 10 art pass. `P1` should ship. `P2` is nice to
have and can be cut without anyone noticing.

**Sourcing order rule:** acquire nothing before Phase 9 is signed off. Grey boxes carry
the build through both feel gates. If the drone isn't fun as a floating cube, art won't
rescue it.

---

## 1. MESHES

### 1.1 Runner character

| Asset | Route | Priority | Notes |
|---|---|---|---|
| Runner base mesh, rigged humanoid | KEN | P0 | Kenney "Blocky Characters" or "Mini Characters". Already chunky, already rigged, CC0. Do not model from scratch. |
| 6 colourway materials | PROC | P0 | Single mesh, material tint swap by player index. No 6 separate files. |
| Sticker face decals ×4 | PROC | P1 | Plane with alpha texture parented to head. Four expressions: neutral, panic, dead, gremlin. |
| Carry pose attachment point | PROC | P0 | Empty bone socket above head for the power core. |

**Critical:** pick the rig **once**, at the top of Phase 10, before any animation is
retargeted. Changing rigs later invalidates every clip below.

### 1.2 Drone

| Asset | Route | Priority | Notes |
|---|---|---|---|
| Drone body, unrigged | HF | P0 | Prompt: fat plastic toy quadcopter, chunky rounded body, oversized rotor guards, pastel colours, googly eye sticker on front, flat `#808080` background, NO TEXT, no letters, no watermark |
| Rotors ×4, separate objects | PROC or HF | P0 | Must be separate transforms so code can spin them. If HF returns them fused, replace with procedural cylinders. |
| Battery gauge panel | PROC | P0 | Emissive quad on the drone body, driven by battery percentage. Must be readable across the arena — this is a mechanic, not decoration. |
| Damage/knockdown state | PROC | P1 | Material swap plus a tilt offset. No separate mesh. |

### 1.3 Arena

| Asset | Route | Priority | Notes |
|---|---|---|---|
| Walls, floor, ramps, platform, pillars, tunnel | PROC | P0 | All primitives. Built in Phase 1, kept permanently. |
| Charge pad ×3 | PROC | P0 | Cylinder base, emissive ring, state colours: green available, red core-blocked, blue drone docked, grey sabotaged |
| EMP station | HF | P0 | Prompt: chunky pastel sci-fi toy machine, three empty cylindrical core slots on the front, big lever, rounded plastic look, flat `#808080` background, NO TEXT, no letters, no watermark |
| Power core ×3 | HF | P0 | Prompt: glowing pastel battery cell, rounded capsule shape, chunky plastic toy, flat `#808080` background, NO TEXT, no letters, no watermark. Chain all three off one completed mesh so proportions match. |
| Ceiling fan ×2 | KEN or PROC | P1 | Rotating blades, procedural is fine |
| Streamer net ×3 | PROC | P1 | Vertical ribbon strips, simple vertex wobble shader |
| Throwable props ×4 | KEN | P1 | Kenney prop packs — crate, ball, cone, bucket |
| Gremlin avatar | HF | P2 | Small floating version of the runner silhouette, semi-transparent |

**Higgsfield discipline reminder:** count 1, `nano_banana_pro` for concept passes, chain
variants off completed meshes by media ID so palette and proportions stay consistent,
never request isolated floating objects for anything the code has to register or align.

---

## 2. ANIMATIONS

### 2.1 Sourced clips (Mixamo, retargeted onto the KEN rig)

| Clip | Route | Priority | Notes |
|---|---|---|---|
| Idle | MIX | P0 | Subtle, looping |
| Run cycle | MIX | P0 | Must loop cleanly at `RUN_SPEED` 6.0 m/s |
| Walk / carry cycle | MIX | P0 | Slower, arms up. Used at `CARRY_SPEED`. |
| Jump start / apex / land | MIX | P0 | Three clips, blended by vertical velocity |
| Swat / melee swing | MIX | P1 | Short arc, must read in 0.3 s |
| Interact hold | MIX | P1 | Crouched, both hands forward. Used for core insert and pad sabotage. |
| Death / elimination | MIX | P1 | Comedic ragdoll launch preferred over a keyframed clip — Rapier can do this for free |
| Victory / defeat idle | MIX | P2 | Round-end screen only |

### 2.2 Procedural animation (no files — Claude Code writes these)

| Behaviour | Priority | Notes |
|---|---|---|
| Squash on landing, stretch on jump | P0 | Built in Phase 1. Carries most of the tone on its own. |
| Drone tilt from velocity | P0 | Phase 2, capped at `TILT_MAX` |
| Rotor spin, RPM-linked | P0 | Speed tied to thrust, drops to idle on the pad |
| Drone red pulse during telegraph | P0 | Phase 3 |
| Core bob and glow pulse when unheld | P1 | |
| Charge pad ring rotation | P1 | |
| Streamer net wobble | P2 | Vertex shader |
| Camera punch, screen shake, hit stop | P0 | Phase 10 juice pass |

**The point of this split:** roughly 60% of the perceived animation quality comes from the
procedural column, which costs nothing to source. Do that pass first and reassess what's
actually still missing.

---

## 3. SOUND EFFECTS

### 3.1 Synthesised at runtime (WEBAUDIO — no files)

| Sound | Priority | Notes |
|---|---|---|
| Prop whine | P0 | **Do not use a sample.** Layered oscillators driven by RPM and distance. Continuous pitch shift is a core mechanic — runners must locate the drone by ear. A looped sample cannot do this convincingly. |
| EMP charge whine | P0 | Rising sawtooth over `EMP_CHARGE_TIME`, resolving into the fire |
| Battery low warble | P0 | Layered under the prop whine during telegraph |
| UI clicks, hovers | P1 | Short synthesised blips |

### 3.2 Generated files (ElevenLabs)

| Sound | Priority | Notes |
|---|---|---|
| Detonation pop | P0 | Party-popper energy, not an explosion. Celebratory. |
| Confetti burst tail | P0 | Layered under the pop |
| EMP fire | P0 | Deep whump plus electrical crackle |
| Core pickup | P0 | Chunky plastic click |
| Core insert lock | P0 | Satisfying mechanical clunk |
| Core drop / fumble | P1 | |
| Swat whoosh, swat connect | P1 | Two files, connect is heavier |
| Drone wall bonk | P1 | Hollow plastic knock. Pitch-randomise in code. |
| Drone knockdown crash | P1 | |
| Drone dock / recharge hum | P1 | Loopable |
| Ceiling fan whoosh | P1 | Loopable, positional |
| Net tangle | P2 | |
| Pad sabotage fizzle | P2 | |
| Footsteps ×4 variants | P2 | Randomised. Genuinely optional at this scale. |
| Gremlin ability trigger | P2 | |

### 3.3 Ambience

| Sound | Priority | Notes |
|---|---|---|
| Arena room tone | P1 | Loopable, low, barely present. Must not mask the prop whine. |

**Audio mixing constraint:** the prop whine sits at the top of the mix at all times.
Anything that competes with it in the same frequency band gets ducked. Losing the ability
to hear the drone breaks Phase 3's acceptance criteria.

---

## 4. MUSIC

| Track | Route | Priority | Notes |
|---|---|---|---|
| Menu / lobby loop | SUNO | P1 | Bright, bouncy, toy-box energy |
| Round music | SUNO | P2 | **Consider shipping without this.** Silence plus prop whine plus footsteps is more tense and keeps the audio mechanic clean. Test both before committing. |
| Round-end sting, win | SUNO | P1 | 3–4 s |
| Round-end sting, loss | SUNO | P1 | 3–4 s |
| Match results theme | SUNO | P2 | |

---

## 5. UI AND 2D

| Asset | Route | Priority | Notes |
|---|---|---|---|
| Battery HUD | PROC | P0 | Percentage plus bar, always visible to everyone |
| EMP progress bar | PROC | P0 | Core count plus charge fill |
| Round timer | PROC | P0 | |
| Player list / alive indicators | PROC | P0 | |
| Damage/proximity vignette | PROC | P1 | Red edge pulse scaling with drone distance |
| Logo / wordmark | HF | P1 | Chunky inflated 3D lettering, pastel |
| Icon set — core, EMP, drone, swat | KEN | P1 | Kenney UI packs, CC0 |
| Font | — | P0 | Any heavy rounded sans. Fredoka, Baloo 2, or Nunito Black — all free on Google Fonts. |

---

## 6. LICENSING NOTE

Kenney assets are CC0 — no attribution required, commercial use fine. Mixamo is free for
commercial use under an Adobe account. Higgsfield, ElevenLabs and Suno outputs follow
whichever plan tier you generate under — check the commercial-use terms on each before
the build ships publicly, not after.

---

## 7. MINIMUM SHIPPABLE SET

If everything else is cut, this is the list that still produces a game that looks and
sounds intentional:

1. Kenney runner mesh, 6 tints
2. Mixamo idle, run, carry, jump, land
3. Higgsfield drone, EMP station, power core
4. Procedural arena, pads, all juice
5. Synthesised prop whine and EMP charge
6. ElevenLabs detonation pop, EMP fire, core pickup, core insert
7. One rounded font, procedural HUD

That's three sourced meshes, five animation clips and four audio files. Everything else on
this manifest is upside.
