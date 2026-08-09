/**
 * BUZZKILL — global tuning surface.
 *
 * This file is the ONLY place tuning constants may live. No magic numbers
 * anywhere else in the codebase (client, server or shared logic).
 *
 * Units: metres, seconds, radians, newtons. World is Y-up, right-handed.
 *
 * Every value from section 4 of the build brief is present below under its
 * brief name. Where the brief used a bare name that would collide across
 * sections (MAX_SPEED, ACCELERATION, LINEAR_DAMPING all sit under "Drone"),
 * the name carries a DRONE_ prefix. Values NOT specified by the brief are
 * marked `derived` (computed from a brief value) or `unspecified` (a choice
 * that had to be made to build the phase); those are the only numbers here
 * that are up for debate.
 */

// ---------------------------------------------------------------------------
// SIMULATION
// ---------------------------------------------------------------------------

/** Fixed physics step — 60 Hz. Rendering interpolates between steps. */
export const FIXED_TIMESTEP = 1 / 60;

/**
 * unspecified. Hard cap on physics steps consumed per rendered frame.
 * Prevents the spiral-of-death when a backgrounded tab returns with a huge
 * accumulated delta.
 */
export const MAX_STEPS_PER_FRAME = 5;

/** unspecified. Frame deltas above this are treated as a stall and discarded. */
export const MAX_FRAME_DELTA = 0.25;

/**
 * unspecified. The brief fixes JUMP_IMPULSE at 7.0 but names no gravity.
 * At earth gravity that impulse gives a 2.5 m apex and ~1.4 s of hang time,
 * which reads as floaty rather than chunky. -16 gives a 1.53 m apex and
 * ~0.88 s airborne. This is the single most likely dial to move at the
 * phase 1 feel gate.
 */
export const GRAVITY = -16.0;

// ---------------------------------------------------------------------------
// NETWORK (phase 5+)
// ---------------------------------------------------------------------------

/** Client -> server input/position send rate. */
export const CLIENT_SEND_HZ = 20;
/** Server -> client state broadcast rate. */
export const SERVER_BROADCAST_HZ = 20;
/** Colyseus allowReconnection window (phase 6). */
export const RECONNECT_WINDOW = 30;
/**
 * unspecified. Smoothing half-life for remote entities. The server broadcasts
 * at 20 Hz and we render at 60+, so without interpolation everyone else moves
 * in visible steps. Never applied to the local player — that would be a
 * correction, which sacred constraint 5 forbids.
 */
export const NET_INTERPOLATION_LAG = 0.08;

// ---------------------------------------------------------------------------
// ARENA
// ---------------------------------------------------------------------------

/**
 * 80 x 80 m village arena (handoff 03, section 3). Grew from 60 x 60 — +78%
 * area, which is a balance change, not a cosmetic one; the section 3 constant
 * changes (drone speed, fuse, round time) exist to pay for it.
 */
export const ARENA_SIZE = 80;
/** Ceiling height. Caps the drone's playable volume from above. */
export const ARENA_CEILING = 14;
/** derived. Half-extent, i.e. the wall line on each axis. */
export const ARENA_HALF = ARENA_SIZE / 2;
/** unspecified. Wall thickness, purely structural. */
export const WALL_THICKNESS = 1;

/** Triangular spread, none within 15 m of another. */
export const CHARGE_PAD_COUNT = 3;
/** unspecified. Pad footprint — a drone must be able to dock inside it. */
export const CHARGE_PAD_RADIUS = 2.0;
export const CHARGE_PAD_HEIGHT = 0.14;

/**
 * Handoff 03: deliberately UNEVEN distances from the windmill — one close
 * (~15 m), two far (~30 m) — so which core to take first is a real decision.
 * Inter-pad spacing stays over the brief's 15 m floor (39.6 / 54 / 39.6 m).
 */
export const CHARGE_PAD_POSITIONS = [
  [0.0, -15.0],
  [27.0, 14.0],
  [-27.0, 14.0],
] as const;

/** Arena centre: the windmill IS the EMP station (handoff 03, section 2). */
export const EMP_STATION_COUNT = 1;
export const EMP_STATION_POSITION = [0.0, 0.0] as const;
/**
 * Zone runners must stand in to charge the EMP. Widened with the windmill
 * tower in the middle of it: the standable part is the annulus between the
 * tower wall and this radius, and it has to hold three bodies comfortably.
 */
export const EMP_STATION_RADIUS = 4.0;
export const EMP_STATION_HEIGHT = 0.18;

// ---------------------------------------------------------------------------
// GREYBOX VILLAGE LAYOUT (handoff 03, session 6)
//
// Primitives only — session 8 swaps meshes onto this layout after it has been
// validated, exactly as the original arena was validated before its art.
//
// The layout rule that shaped every position: the straight lines between the
// runner spawn, the windmill, and each pad stay unobstructed. Bots steer in
// straight lines with no pathfinding, and a building squarely on a working
// route would deadlock the loop; buildings break DIAGONAL sightlines instead,
// which is what the handoff wants from them.
// ---------------------------------------------------------------------------

/**
 * The windmill mound: stepped discs so it is approachable from all sides.
 * Each step is 0.3 m — under the runner's 0.4 m autostep. [radius, topY].
 */
export const MOUND_STEPS = [
  [8.0, 0.3],
  [5.5, 0.6],
] as const;
/** Windmill tower: radius, and the height its cap reaches. */
export const WINDMILL_RADIUS = 1.8;
export const WINDMILL_TOP = 10.0;

/**
 * Cottages: [x, z, sizeX, sizeZ, roofY]. Flat-topped greybox; rooftops sit in
 * the handoff's 6-8 m band so the drone clears them inside ALTITUDE_MAX but
 * remains swattable from up there. Clusters NW/NE with alleys, singles E/W/SE.
 */
export const COTTAGES = [
  [-17.0, -19.0, 6.0, 5.0, 6.2],
  [-11.0, -25.0, 5.0, 5.0, 6.8],
  [17.0, -19.0, 6.0, 5.0, 6.2],
  [11.0, -25.0, 5.0, 5.0, 7.4],
  [-27.0, 8.0, 6.0, 6.0, 6.0],
  [26.0, -2.0, 6.0, 6.0, 6.0],
  [16.0, 26.0, 5.0, 5.0, 6.4],
] as const;

/**
 * The barn: [x, z, sizeX, sizeZ, wallTopY]. Hollow — walls with two door
 * openings and a roof slab, so the drone can fly the interior but has to slow
 * down to thread the doors. Roof slab sits on the walls (walkable at ~6 m).
 */
export const BARN = [-22.0, -6.0, 8.0, 10.0, 5.6] as const;
export const BARN_WALL_THICKNESS = 0.4;
export const BARN_ROOF_THICKNESS = 0.4;
/** Door openings: width and height. Drone diameter is 1.1 m — it fits, slowly. */
export const BARN_DOOR_WIDTH = 3.5;
export const BARN_DOOR_HEIGHT = 3.6;

/**
 * Crate stairs to rooftops: [baseX, baseZ, stepX, stepZ, topY]. Each entry is
 * one stack of ascending boxes ending a jumpable 1.2 m below its cottage roof
 * (jump apex is 1.53 m). Placed against a cottage or barn face.
 */
export const CRATE_STAIRS = [
  // East cottage (26,-2): stack along the south face, tallest crate FLUSH
  // against the wall. Verified the hard way: a 0.85 m gap between crate and
  // wall turns the final 1.2 m rise into a long jump that clips the roof lip.
  [26.0, 1.85, 1.7, 0.0, 4.8],
  // NW cottage (-17,-19): along its east face, flush.
  [-13.15, -19.0, 0.0, 1.7, 5.0],
  // Barn: hay bales up the south face, flush.
  [-22.0, -0.15, 1.7, 0.0, 4.8],
] as const;
/** Footprint of one crate/hay step, and the rise per step. */
export const CRATE_STEP_SIZE = 1.7;
export const CRATE_STEP_RISE = 1.2;

/** Low stone walls: [x, z, length, yawRadians]. Partial cover, hop-over-able. */
export const STONE_WALLS = [
  [-14.0, 8.0, 8.0, 0.0],
  [14.0, 8.0, 8.0, 0.0],
  [0.0, -26.0, 10.0, 0.0],
] as const;
export const STONE_WALL_HEIGHT = 0.9;
export const STONE_WALL_THICKNESS = 0.5;

/** Hedgerows: [x, z, length, yawRadians]. Taller cover — blocks sight, not shot. */
export const HEDGES = [
  [-20.0, 26.0, 8.0, 0.5],
  [22.0, 20.0, 8.0, -0.9],
  [-22.0, -16.0, 7.0, 1.2],
  [22.0, -14.0, 7.0, -1.2],
] as const;
export const HEDGE_HEIGHT = 1.4;
export const HEDGE_THICKNESS = 0.9;

/**
 * Market stalls: [x, z, yawRadians]. The market square is the open ground
 * between the mound and the spawn — the dangerous crossing. Stalls dress its
 * edges without blocking the spawn-to-windmill lane.
 */
export const MARKET_STALLS = [
  [-9.0, 16.0, 0.3],
  [9.0, 16.0, -0.3],
  [-4.0, 21.0, 0.1],
] as const;
export const STALL_SIZE = 1.8;
export const STALL_HEIGHT = 2.2;

/** unspecified. Structural thicknesses for the greybox shell. */
export const GROUND_THICKNESS = 1.0;
export const CEILING_THICKNESS = 1.0;
export const RAMP_THICKNESS = 0.4;
/** unspecified. Radial segments on cylindrical greybox meshes. */
export const CYLINDER_SEGMENTS = 40;

// ---------------------------------------------------------------------------
// RUNNER
// ---------------------------------------------------------------------------

export const RUN_SPEED = 6.0;
/** While holding a power core (phase 4). */
export const CARRY_SPEED = 4.5;
export const JUMP_IMPULSE = 7.0;
export const CAPSULE_RADIUS = 0.5;
/** Total capsule height, both caps included. */
export const CAPSULE_HEIGHT = 1.8;
/** derived. Rapier takes the cylinder half-height, excluding the caps. */
export const CAPSULE_HALF_HEIGHT = CAPSULE_HEIGHT / 2 - CAPSULE_RADIUS;
export const COYOTE_TIME = 0.12;
/** Air control as a fraction of ground control (phase 1 task list). */
export const AIR_CONTROL = 0.6;

/** unspecified. Oversized head sphere — chunky toy proportions from frame one. */
export const HEAD_RADIUS = 0.62;
/** unspecified. Ground acceleration toward the target velocity. */
export const RUN_ACCEL = 60.0;
/** unspecified. Ground deceleration once input is released. */
export const RUN_DECEL = 45.0;
/** unspecified. Jump press remembered this long before landing. */
export const JUMP_BUFFER_TIME = 0.12;
/** unspecified. Terminal fall speed. */
export const MAX_FALL_SPEED = 38.0;

/** unspecified. Rapier kinematic character controller setup. */
export const CONTROLLER_OFFSET = 0.02;
export const CONTROLLER_MAX_SLOPE = Math.PI / 4;
/**
 * Slopes steeper than this make the character slide back down. Held equal to
 * CONTROLLER_MAX_SLOPE on purpose: anything the runner can climb, it keeps.
 * Setting it lower silently makes the steeper ramps unclimbable.
 */
export const CONTROLLER_MIN_SLIDE_SLOPE = Math.PI / 4;
export const CONTROLLER_AUTOSTEP_HEIGHT = 0.4;
export const CONTROLLER_AUTOSTEP_MIN_WIDTH = 0.2;
export const CONTROLLER_SNAP_TO_GROUND = 0.3;
/** unspecified. Runner spawn point (capsule centre). */
export const RUNNER_SPAWN = [0.0, 2.0, 32.0] as const;
/** unspecified. Downward bias applied while grounded so the controller sticks. */
export const STICK_TO_GROUND_SPEED = 2.0;
/**
 * unspecified. Runner mass, used only to convert external forces (prop wash)
 * into a velocity change. The runner is kinematic, so the solver never sees it.
 */
export const RUNNER_MASS = 1.0;
/** unspecified. Rate at which the body turns to face its direction of travel. */
export const FACING_TURN_RATE = 14.0;
/** unspecified. Speeds below this count as standing still. */
export const MOVE_EPSILON = 0.05;
/** unspecified. Vertical shortfall that counts as a ceiling hit. */
export const CEILING_BLOCK_EPSILON = 1e-4;
/** unspecified. Fall below this and the runner is returned to spawn. */
export const RESPAWN_Y_THRESHOLD = -5.0;
/** derived. Distance from the capsule centre down to the feet. */
export const FOOT_OFFSET = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;
/** derived. Head sphere centre, above the capsule centre. */
export const HEAD_OFFSET = CAPSULE_HALF_HEIGHT + HEAD_RADIUS * 0.55;

// ---------------------------------------------------------------------------
// SQUASH & STRETCH (unspecified — phase 1 asks for it, gives no numbers)
// ---------------------------------------------------------------------------

/** Vertical scale at the instant of landing. */
export const SQUASH_LAND_SCALE = 0.68;
/** Vertical scale at the instant of jumping. */
export const STRETCH_JUMP_SCALE = 1.28;
/** Time to recover to neutral scale. Longer reads as bouncier, softer plastic. */
export const SQUASH_RECOVER_TIME = 0.42;
/** Impact speed at which landing squash reaches full strength. */
export const SQUASH_FULL_IMPACT_SPEED = 9.0;
/** Lean into the direction of travel, radians at full speed. */
export const RUN_LEAN_MAX = 0.16;
/** Run bob amplitude, and cycles per second at full speed. */
export const RUN_BOB_AMPLITUDE = 0.07;
export const RUN_BOB_FREQUENCY = 2.4;
/**
 * Wobble cycles spanned over one full recovery. The envelope is keyed to
 * SQUASH_RECOVER_TIME rather than to wall-clock decay, so the wobble always
 * lands exactly on neutral instead of being cut off mid-swing.
 */
export const SQUASH_WOBBLE_CYCLES = 1.25;

// ---------------------------------------------------------------------------
// CAMERA (unspecified — phase 1 asks for follow lag and wall avoidance)
// ---------------------------------------------------------------------------

export const CAMERA_DISTANCE = 7.0;
/** Height of the look-at target above the runner's feet. */
export const CAMERA_TARGET_HEIGHT = 1.5;
/** Follow smoothing half-life. Higher is laggier. */
export const CAMERA_LAG = 0.09;
/** Sphere cast radius used to keep the camera out of geometry. */
export const CAMERA_COLLISION_RADIUS = 0.4;
/** Closest the camera may pull in when geometry is behind the player. */
export const CAMERA_MIN_DISTANCE = 1.2;
/** Rate at which the camera eases back out once a blocker clears. */
export const CAMERA_UNBLOCK_SPEED = 6.0;
/** Resting pitch: looking slightly down frames the runner better than level. */
export const CAMERA_PITCH_START = 0.2;
export const CAMERA_PITCH_MIN = -0.9;
export const CAMERA_PITCH_MAX = 1.05;
export const CAMERA_FOV = 62;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 400;
export const MOUSE_SENSITIVITY = 0.0024;

// ---------------------------------------------------------------------------
// DRONE (phase 2)
// ---------------------------------------------------------------------------

/** Handoff 03: 9.0 -> 11.0 so the drone can still pressure an 80 m map. */
export const DRONE_MAX_SPEED = 11.0;
/** Handoff 03: 8.0 -> 9.0, same reason as the speed bump. */
export const DRONE_ACCELERATION = 9.0;
/**
 * SACRED CONSTRAINT 1: hard cap 0.8. Above that the drone can park on a
 * target and hold position, and the game dies.
 */
export const DRONE_LINEAR_DAMPING = 0.6;
/** Visual tilt follows velocity, capped at 25 degrees. */
export const TILT_MAX = (25 * Math.PI) / 180;
/**
 * OVERRIDDEN BY THE DIRECTOR. The brief specifies 1.5 / 12.0; the band was
 * widened on request so the drone can get right down to floor level and up
 * near the 14 m ceiling. Docking on a charge pad in phase 3 needs the low end
 * anyway.
 */
export const ALTITUDE_MIN = 0.6;
export const ALTITUDE_MAX = 13.0;
/** Wall and ceiling restitution — it should visibly bonk. */
export const WALL_BOUNCE = 0.45;
/** Pushes runners, never damages. */
export const PROP_WASH_RADIUS = 3.0;
export const PROP_WASH_FORCE = 12.0;

/** unspecified. Body shape and mass. */
export const DRONE_RADIUS = 0.55;
export const DRONE_BODY_HEIGHT = 0.3;
export const DRONE_MASS = 1.2;
export const DRONE_ANGULAR_DAMPING = 2.5;
export const DRONE_FRICTION = 0.2;
/** unspecified. Tilt smoothing rate toward the velocity-derived target. */
export const TILT_RESPONSE = 7.0;
/**
 * derived. Speed at which the visual tilt reaches TILT_MAX. Tied to top speed,
 * so full tilt reads as "flat out" rather than being reached halfway there.
 */
export const TILT_FULL_SPEED = DRONE_MAX_SPEED;
/** unspecified. Soft spring resisting travel outside the altitude band. */
export const ALTITUDE_SPRING = 34.0;
export const ALTITUDE_SPRING_DAMPING = 5.5;
/** unspecified. Downward share of prop wash, as a fraction of radial force. */
export const PROP_WASH_DOWNFORCE = 0.35;
/** unspecified. Speed multiplier while limping back to a pad (phase 3). */
export const DRONE_RETURN_SPEED_MULT = 0.5;

/** unspecified. Drone launch point. */
export const DRONE_SPAWN = [0.0, 6.0, -26.0] as const;
/**
 * unspecified. Vertical acceleration from Space / Shift. The drone cancels its
 * own weight first (a toy drone that sinks the moment you stop holding Space is
 * miserable to fly), so this is climb authority on top of a neutral hover.
 */
export const DRONE_VERTICAL_ACCELERATION = 17.0;
/** Fraction of gravity the rotors cancel while powered. 1 = neutral hover. */
export const DRONE_HOVER_COMPENSATION = 1.0;
/**
 * unspecified. Thrust cuts out at DRONE_MAX_SPEED and resumes below it, which
 * caps top speed at the brief's value without ever assigning velocity (sacred
 * constraint 1 forbids that). A smooth falloff cannot work here: at 9 m/s the
 * brief's own damping of 0.6 already eats 5.4 of the 8.0 m/s^2 available, so
 * any gradual falloff settles the drone near 5.4 m/s and it never reaches the
 * stated top speed.
 */
export const DRONE_THRUST_CUTOFF = DRONE_MAX_SPEED;

/**
 * A slow wander so the drone cannot be parked, from two incommensurate sines
 * (deterministic, no RNG, so clients agree in phase 5).
 *
 * SET TO 0 BY THE DIRECTOR, who chose to override sacred constraint 1's clause
 * that "if the drone can hover precisely on a target and hold position, the
 * game is dead". Momentum and drift are untouched — the drone still coasts ~11 m
 * after you release the stick — it just settles instead of creeping. Raise this
 * back to ~0.3 to restore the constraint; nothing else needs to change.
 */
export const DRONE_WANDER_ACCELERATION = 0.0;
export const DRONE_WANDER_HZ_X = 0.37;
export const DRONE_WANDER_HZ_Z = 0.29;

/** unspecified. Rotor geometry and spin, in radians per second. */
export const ROTOR_COUNT = 4;
export const ROTOR_RADIUS = 0.26;
export const ROTOR_ARM = 0.42;
export const ROTOR_THICKNESS = 0.05;
export const ROTOR_SPIN_IDLE = 14.0;
export const ROTOR_SPIN_MAX = 55.0;

/** unspecified. Chase camera for the drone. It sits further back and higher. */
export const DRONE_CAMERA_DISTANCE = 6.5;
export const DRONE_CAMERA_HEIGHT = 1.4;
export const DRONE_CAMERA_LAG = 0.14;
/** Yaw turn rate from the mouse while piloting. */
export const DRONE_YAW_SENSITIVITY = 0.0022;

/**
 * unspecified. External shoves (prop wash) decay on the runner at this rate.
 * The runner is kinematic, so pushes are integrated by hand rather than by the
 * solver applying an impulse.
 */
export const PUSH_DECAY = 3.2;
/** Dead on the floor immediately after detonation (phase 3 task list). */
export const DRONE_INERT_TIME = 2.0;

// ---------------------------------------------------------------------------
// BATTERY / FUSE (phase 3)
// ---------------------------------------------------------------------------

/**
 * Fuse length in seconds per detonation cycle; index 5+ clamps to the last.
 * Highest-leverage balance lever in the game — tune this first.
 *
 * Handoff 03 sets [70, 52, 40, 32, 25] for the 80 x 80 map and flags them as
 * starting guesses, to be retuned from telemetry. NOTE: this supersedes the
 * director's earlier "1.5x faster" call ([40, 30, 23, 19, 15]), which was
 * made for the 60 x 60 arena. If detonations now feel too rare, this is the
 * first number to revisit — and the round metrics say so either way.
 */
export const FUSE_BY_CYCLE = [70, 52, 40, 32, 25] as const;

export const DETONATION_RADIUS = 4.0;
/** Last 3 s: drone flashes red, prop pitch rises. */
export const TELEGRAPH_TIME = 3.0;
/** Drone immobile and vulnerable on the pad. */
export const RECHARGE_TIME = 8.0;
/** Grounded, then must fly to a pad. Never lethal (sacred constraint 4). */
export const KNOCKDOWN_RECOVERY = 6.0;
/** Volume and pitch scale with distance. */
/** Handoff 03: 15 -> 20 m. Buildings make locating by ear the key mechanic. */
export const PROP_AUDIBLE_RADIUS = 20.0;

/** unspecified. Telegraph pulse rate at the start and end of the window. */
export const TELEGRAPH_PULSE_HZ_START = 2.0;
export const TELEGRAPH_PULSE_HZ_END = 8.0;
/** unspecified. Prop whine pitch across idle -> full throttle. */
export const PROP_PITCH_MIN = 0.75;
export const PROP_PITCH_MAX = 1.6;

/**
 * unspecified. Prop whine synthesis. The asset manifest forbids a sample here:
 * continuous pitch shift is how runners locate the drone by ear, and a loop
 * cannot do it convincingly.
 */
export const PROP_WHINE_BASE_HZ = 118;
export const PROP_WHINE_LAYERS = 3;
export const PROP_WHINE_DETUNE = 22;
export const PROP_WHINE_FILTER_HZ = 1400;
export const PROP_WHINE_GAIN = 0.16;
/** Battery-low warble layered under the whine during the telegraph. */
export const TELEGRAPH_WARBLE_HZ = 11;
export const TELEGRAPH_WARBLE_DEPTH = 42;

// ---------------------------------------------------------------------------
// DETONATION PRESENTATION (phase 3)
// ---------------------------------------------------------------------------

/** unspecified. Confetti burst — bright and celebratory, never gory. */
export const CONFETTI_COUNT = 220;
export const CONFETTI_SPEED = 11.0;
export const CONFETTI_LIFETIME = 1.6;
export const CONFETTI_SIZE = 0.22;
export const CONFETTI_GRAVITY = -11.0;
export const CONFETTI_COLORS = [
  0xff8fa3, 0xffd166, 0x8fe3c4, 0x9bb8ff, 0xd7a6ff, 0xfff3b0,
] as const;

/** unspecified. Emissive pulse on the drone body during the telegraph. */
export const TELEGRAPH_COLOR = 0xff4d5e;
/** unspecified. Size of the emissive battery gauge on the drone's body. */
export const BATTERY_GAUGE_WIDTH = 0.62;
export const BATTERY_GAUGE_HEIGHT = 0.16;

/**
 * Charge pad state colours (asset manifest, PROC, P0):
 * green available, red core-blocked, blue drone docked, grey sabotaged.
 */
export const PAD_COLOR_AVAILABLE = 0x2fd9ff;
export const PAD_COLOR_BLOCKED = 0xff3df0;
export const PAD_COLOR_DOCKED = 0x9b4dff;
export const PAD_COLOR_SABOTAGED = 0x9aa2a8;
/** Pad ring rotation, so an active pad reads as live (manifest, PROC, P1). */
export const PAD_RING_SPIN = 0.5;

/**
 * Six runner colourways, tinted per player index (manifest, PROC, P0).
 *
 * Revised in the session 5 materials pass. The first set was six pastels of
 * near-identical lightness, which is the one thing that does not survive 30 m:
 * hue desaturates with distance and haze, and what is left to tell people
 * apart is value. These alternate light and dark as well as walking round the
 * wheel, so they stay separable both at range and to a colour-blind player.
 * Still pastel — the look is oversized plastic, not team shooter.
 */
export const RUNNER_COLORWAYS = [
  0xf28f8f, // coral      light warm
  0x3f7fc4, // deep blue  dark cool
  0xf6c667, // amber      light warm
  0x6b4fa8, // violet     dark cool
  0x7fd4a8, // mint       light cool
  0xc4437f, // magenta    dark warm
] as const;

/** unspecified. Battery gauge colours, readable across the arena (phase 10). */
export const BATTERY_COLOR_FULL = 0x35e6ff;
export const BATTERY_COLOR_LOW = 0xffd166;
export const BATTERY_COLOR_CRITICAL = 0xff4d5e;
/** Battery fraction below which the gauge reads "low". */
export const BATTERY_LOW_FRACTION = 0.35;

/** unspecified. Drone docking and post-detonation behaviour. */
export const DRONE_DOCK_RADIUS = 1.2;
/** Steering force used while the drone flies itself back to a pad. */
export const DRONE_RETURN_ACCELERATION = 6.0;
/** Altitude the drone holds while limping back to a pad. */
export const DRONE_RETURN_ALTITUDE = 3.0;
/** Height above the pad at which the drone counts as docked. */
export const DRONE_DOCK_HEIGHT = 0.6;

/** derived. Fuse for a given cycle, clamped to the final entry. */
export function fuseForCycle(cycle: number): number {
  const index = Math.min(Math.max(cycle, 0), FUSE_BY_CYCLE.length - 1);
  return FUSE_BY_CYCLE[index] as number;
}

// ---------------------------------------------------------------------------
// POWER CORES / EMP (phase 4)
// ---------------------------------------------------------------------------

export const CORES_REQUIRED = 3;
/** Interrupted if the runner moves or is hit. */
export const CORE_INSERT_HOLD = 3.0;
/** After the 3rd core is inserted. */
export const EMP_CHARGE_TIME = 20.0;
/** 1 runner if <=2 alive, else 2 runners simultaneously. */
export const EMP_CHARGE_MIN_PRESENT_LOW = 1;
export const EMP_CHARGE_MIN_PRESENT_HIGH = 2;
/** derived. Alive-runner count at or above which the high requirement applies. */
export const EMP_CROWDED_THRESHOLD = 3;
/** Charge decays at 50% of fill rate when unattended. */
export const EMP_DRAIN_ON_ABANDON = 0.5;

/** unspecified. Pickup on proximity + hold E. */
export const CORE_PICKUP_RADIUS = 1.8;
export const CORE_PICKUP_HOLD = 1.5;
export const CORE_RADIUS = 0.35;
/** unspecified. Height a carried core floats above the runner's head. */
export const CORE_CARRY_HEIGHT = 0.8;
/** unspecified. A core within this of a pad centre counts as sitting on it. */
export const CORE_ON_PAD_RADIUS = 2.2;
/** unspecified. Moving faster than this cancels a hold-to-interact. */
export const INTERACT_MOVE_CANCEL_SPEED = 0.6;
/**
 * unspecified. Wash force needed to knock a carried core loose. Prop wash falls
 * off to nothing at the edge of its radius, so without a threshold the faintest
 * brush drops the core and carrying one anywhere becomes impossible. At 5.0 of
 * PROP_WASH_FORCE's 12.0 the drone has to be genuinely overhead.
 */
export const CORE_DROP_PUSH = 5.0;
/** unspecified. Core bob, so an unheld core reads as pickup-able. */
export const CORE_BOB_HEIGHT = 0.18;
export const CORE_BOB_HZ = 0.55;
export const CORE_SPIN_RATE = 1.1;
/** Handoff 03: gameplay objects live on cyan/magenta, hues the village palette never uses. */
export const COLOR_CORE = 0x35e6ff;
export const COLOR_CORE_CARRIED = 0xa9f6ff;

/**
 * unspecified. Juice pass (phase 10). Shake is in metres of camera offset,
 * punch is in degrees of FOV, hit stop is in seconds.
 */
export const SHAKE_DETONATION = 0.55;
export const SHAKE_KNOCKDOWN = 0.18;
export const SHAKE_DECAY = 1.6;
export const SHAKE_FREQUENCY = 42.0;
export const SHAKE_MAX_OFFSET = 0.6;
export const HITSTOP_SWAT = 0.08;
export const PUNCH_EMP = 14.0;
export const PUNCH_RECOVER = 26.0;

/** unspecified. White screen pulse when the EMP fires. */
export const EMP_FLASH_TIME = 1.1;
export const EMP_FLASH_COLOR = 0xffffff;

// ---------------------------------------------------------------------------
// SCRIPTED DRONE (phase 4 — pressure-tests the objective, nothing more)
// ---------------------------------------------------------------------------

/** Drifts toward the nearest runner inside this radius. No pathfinding. */
export const AI_CHASE_RADIUS = 20.0;
/** unspecified. Distance at which a patrol waypoint counts as reached. */
export const AI_WAYPOINT_RADIUS = 4.0;
/** unspecified. Altitude the scripted drone tries to hold while patrolling. */
/** Above the 6-8 m rooftops, so the dumb patrol does not headbutt houses. */
export const AI_PATROL_ALTITUDE = 9.0;
/** unspecified. Altitude it drops to when hunting, so its blast can reach. */
export const AI_ATTACK_ALTITUDE = 1.4;
/**
 * unspecified. Patrol circuit: [x, z]. Deliberately dumb — a loop of points.
 *
 * Routed around the charge pads and NOT through the arena centre. A waypoint on
 * the EMP station makes the scripted drone camp the objective, and with a 3 s
 * insert hold that alone makes the runner win condition unreachable. Patrolling
 * where the cores are is pressure; sitting on the station is a lock-out.
 */
export const AI_WAYPOINTS = [
  [0.0, -22.0],
  [18.0, -10.0],
  [24.0, 10.0],
  [0.0, 22.0],
  [-24.0, 10.0],
  [-18.0, -10.0],
] as const;

/** derived. Runners required in the station zone for the current alive count. */
export function empChargeMinPresent(aliveRunners: number): number {
  return aliveRunners >= EMP_CROWDED_THRESHOLD
    ? EMP_CHARGE_MIN_PRESENT_HIGH
    : EMP_CHARGE_MIN_PRESENT_LOW;
}

// ---------------------------------------------------------------------------
// HAZARDS / COUNTERPLAY (phase 7)
// ---------------------------------------------------------------------------

/** Melee arc on F. Hitting the drone within 2.5 m knocks it down. */
export const SWAT_RANGE = 2.5;
export const SWAT_COOLDOWN = 1.5;
/** unspecified. Half-angle of the swat arc. */
export const SWAT_ARC = 1.2;

/**
 * Rotor hazards (handoff 03, section 2): the windmill's sails sweeping low
 * over the station, plus two barn extractor fans. [x, z, hubY, radius].
 * The sails are the reason the drone's best camping spot — right over the
 * EMP zone — is also the most dangerous place it can sit.
 */
export const FAN_COUNT = 3;
export const FAN_FORCE = 46.0;
export const FAN_POSITIONS = [
  [0.0, 0.0, 8.6, 5.5],
  [-24.0, -8.0, 4.6, 2.0],
  [-20.0, -4.0, 4.6, 2.0],
] as const;

/** 3 static hanging obstacles. Drone passing through is slowed 60% for 2 s. */
export const NET_COUNT = 3;
export const NET_SLOW_FACTOR = 0.4;
export const NET_SLOW_TIME = 2.0;
/** unspecified. Net positions: [x, z, width, yawRadians]. */
export const NET_POSITIONS = [
  [-14.0, -22.0, 6.0, Math.PI / 4],
  [14.0, -22.0, 6.0, -Math.PI / 4],
  [0.0, 12.0, 8.0, 0.0],
] as const;

/** unspecified. Loose props: pick up and throw, deliberately inaccurate. */
export const THROWABLE_COUNT = 8;
export const THROWABLE_RADIUS = 0.3;
export const THROW_FORCE = 15.0;
export const THROW_SPREAD = 0.06;

/** Hold E on an empty charge pad for 4 s to disable it for 30 s. */
export const SABOTAGE_HOLD = 4.0;
export const SABOTAGE_DISABLE_TIME = 30.0;

// ---------------------------------------------------------------------------
// ELIMINATION / GREMLINS (phase 8, all unspecified)
// ---------------------------------------------------------------------------

export const GREMLIN_SPEED = 9.0;
export const GREMLIN_RADIUS = 0.35;
/** One hazard trigger per detonation cycle; cooldown resets on detonation. */
export const GREMLIN_ACTIONS_PER_CYCLE = 1;
export const GREMLIN_SMOKE_RADIUS = 3.0;
export const GREMLIN_SMOKE_TIME = 6.0;
export const GREMLIN_FAN_REVERSE_TIME = 4.0;
/** Gremlins may not act within this distance of the EMP station or the drone. */
export const GREMLIN_EXCLUSION_RADIUS = 2.5;

// ---------------------------------------------------------------------------
// ROUND / MATCH (phase 9)
// ---------------------------------------------------------------------------

/** Handoff 03: 180 -> 210 s. Core runs are longer on the 80 m map. */
export const ROUND_TIME = 210;
/** Match length is max(5, playerCount). */
export const ROUNDS_PER_MATCH_MIN = 5;
export const MIN_PLAYERS = 3;
/**
 * Practice mode only. The 3-player rule is correct for real matches and wrong
 * for testing, so this is a separate minimum rather than a lowered one --
 * real matches still enforce MIN_PLAYERS (handoff 02, session 4).
 */
export const PRACTICE_MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;
/** unspecified. Round-end screen auto-advance (phase 9 task list says 10 s). */
export const ROUND_END_AUTO_ADVANCE = 10;
export const ROOM_CODE_LENGTH = 4;
/** Letters used in room codes. No vowels: avoids accidental words. */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';
/** unspecified. Hard cap on live rooms (phase 11 wants this; it is free now). */
export const MAX_CONCURRENT_ROOMS = 50;

/** A fresh room code. Colyseus filters rooms by this, so it is the join key. */
export function makeRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

export const SCORE_RUNNER_SURVIVE = 1;
/** To every runner alive at fire time. */
export const SCORE_EMP_FIRED = 3;
/** Per elimination. */
export const SCORE_DRONE_ELIM = 2;
/** Bonus for wiping every runner. */
export const SCORE_DRONE_WIPE = 5;

/** derived. */
export function roundsPerMatch(playerCount: number): number {
  return Math.max(ROUNDS_PER_MATCH_MIN, playerCount);
}

// ---------------------------------------------------------------------------
// PRESENTATION — greybox palette and debug rendering (all unspecified)
// ---------------------------------------------------------------------------

/** Pastel primaries. Everything reads as oversized plastic, never gritty. */
export const COLOR_SKY = 0xbfe4f2;
export const COLOR_GROUND = 0xd8d3c6;
export const COLOR_WALL = 0xc7c0b2;
/** Drone body: cool grey-white so it never blends into rooftops or sky. */
export const COLOR_PROP = 0xe6ecf2;
/** Hedgerow green — greybox, but a hedge that is not green reads as a wall. */
export const COLOR_HEDGE = 0x8fbf7f;
export const COLOR_CHARGE_PAD = 0x2fd9ff;
export const COLOR_EMP_STATION = 0x35e6ff;
export const COLOR_RUNNER = 0xf28f8f;
export const COLOR_RUNNER_HEAD = 0xffe3c9;
export const COLOR_DEBUG_CUBE = 0xf5c76a;
export const COLOR_LIGHT_SKY = 0xe8f4ff;
export const COLOR_LIGHT_GROUND = 0xb0a696;

/**
 * How long the melee swing clip is held before the state machine takes the
 * body back. The Kenney clip is short; this stops a swing being cut off by
 * the run cycle on the very next frame.
 */
export const SWAT_ANIM_TIME = 0.45;

/**
 * How far a head turns before the shoulders have to follow, in radians.
 * About 75 degrees — past that a neck stops being plausible and the body
 * comes round instead.
 */
export const HEAD_YAW_MAX = 1.3;
/** Neck easing, in seconds to ~63%. Slow enough that a mouse flick glides. */
export const HEAD_TURN_EASE = 0.09;

/**
 * Village dressing. Decorative only — nothing here has a collider, because the
 * arena's collision layout is tuned and set dressing must not move a surface a
 * player can touch. The module is the native width of the environment kit's
 * wall panel (Quaternius Medieval Village MegaKit): 2 m.
 */
export const VILLAGE_MODULE = 2.0;
/** Radius the ring of houses sits on, outside the arena walls. */
export const VILLAGE_HOUSE_RING = 50.0;
export const VILLAGE_TREE_COUNT = 54;
export const VILLAGE_PROP_COUNT = 22;
/** Tufts of grass, flowers and pebbles inside the play area. */
export const VILLAGE_GRASS_COUNT = 260;

/**
 * Sticker faces (manifest, PROC, P1): four expressions on an alpha plane
 * parented to the head. Drawn to a canvas at boot — no image files.
 */
export const FACE_TEXTURE_SIZE = 128;
export const FACE_PLANE_SIZE = 0.96;
/** Distance at which the drone starts to read as "too close", for the panic face. */
export const FACE_PANIC_RADIUS = 9.0;

/**
 * Proximity vignette (manifest, PROC, P1): red edge pulse that grows as the
 * drone closes. Peaks at the detonation radius, because that is the distance
 * the warning is actually about.
 */
export const VIGNETTE_RADIUS = 14.0;
export const VIGNETTE_MAX_OPACITY = 0.55;
export const VIGNETTE_PULSE_HZ = 2.2;

/**
 * Rim light: a dim, cool light from behind and opposite the sun. It does no
 * work on the lit side and exists only to draw a bright edge on silhouettes,
 * which is what stops a runner disappearing against a same-value wall.
 */
export const RIM_LIGHT_COLOR = 0xcfe8ff;
export const RIM_LIGHT_INTENSITY = 0.55;
export const RIM_LIGHT_POSITION = [-30.0, 16.0, -24.0] as const;

/** Floor ambient-occlusion gradient, generated at runtime (no asset files). */
export const FLOOR_AO_TEXTURE_SIZE = 256;
/** How dark the floor gets in the corners. 0 = flat, 1 = black. */
export const FLOOR_AO_STRENGTH = 0.34;
/** Fraction of the half-extent over which the darkening falls off. */
export const FLOOR_AO_FALLOFF = 0.42;

/** Sky gradient: the horizon colour a large backdrop sphere fades to. */
export const COLOR_SKY_HORIZON = 0xe8f2f7;

/** Pad animation rates, one per state (handoff 02, session 5). */
export const PAD_SPIN_AVAILABLE = 0.35;
export const PAD_SPIN_DOCKED = 2.6;
export const PAD_SPIN_BLOCKED = 0.0;
export const PAD_SPIN_SABOTAGED = -1.4;
/** Pulse rates in Hz. Zero means a steady ring. */
export const PAD_PULSE_AVAILABLE = 0.0;
export const PAD_PULSE_BLOCKED = 1.1;
export const PAD_PULSE_DOCKED = 3.2;
export const PAD_PULSE_SABOTAGED = 6.5;
/** How far the pulse dips the ring's brightness. */
export const PAD_PULSE_DEPTH = 0.45;

/**
 * Light shaft over a carried core, so "who has one" is legible across the
 * arena rather than only at conversational distance.
 */
export const CORE_SHAFT_RADIUS = 0.42;
export const CORE_SHAFT_HEIGHT = 14.0;
export const CORE_SHAFT_OPACITY = 0.38;
export const CORE_SHAFT_SPIN = 0.9;

/**
 * Battery halo: a flat ring around the drone, coloured by charge.
 *
 * The hull gauge is a strip on one face, which is unreadable from in front and
 * unreadable at all at 30 m. Every player is timing their round off the
 * battery, so it needs a readout with no preferred viewing angle — a ring has
 * none, and a metre of saturated colour survives the distance the strip does
 * not. Charge is shown as the ring's colour and its opening angle together.
 */
export const BATTERY_HALO_RADIUS = 1.05;
export const BATTERY_HALO_WIDTH = 0.16;
/** Baseline opacity, and how much brighter it gets as the battery empties. */
export const BATTERY_HALO_OPACITY = 0.5;
export const BATTERY_HALO_OPACITY_LOW = 0.95;
/** Halo pulse, in Hz, once the battery is inside BATTERY_LOW_FRACTION. */
export const BATTERY_HALO_PULSE_HZ = 2.4;

/**
 * Fog is a horizon softener only. The arena diagonal is ~85 m and runners have
 * to spot the drone clear across it, so fog must not start biting inside that.
 */
export const FOG_NEAR = 125;
export const FOG_FAR = 400;
export const HEMI_LIGHT_INTENSITY = 0.85;
/** Warm-cast key against a cool sky fill (handoff 03, section 1). */
export const SUN_LIGHT_INTENSITY = 1.9;
export const SUN_COLOR = 0xffe3bd;
export const TONE_EXPOSURE = 1.06;
/** Mild bloom: threshold keeps it to emissives and the sky, not the walls. */
export const BLOOM_STRENGTH = 0.35;
export const BLOOM_RADIUS = 0.5;
export const BLOOM_THRESHOLD = 0.82;
export const SUN_POSITION = [26.0, 40.0, 18.0] as const;
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_CAMERA_EXTENT = 56;
export const SHADOW_BIAS = -0.0006;
/** Shadow frustum depth. Starting at the default near plane wastes precision. */
export const SHADOW_CAMERA_NEAR = 1;
export const SHADOW_CAMERA_FAR = ARENA_SIZE * 2;
export const MAX_PIXEL_RATIO = 2;

/** Marker ring thickness for pads and the station. */
export const MARKER_RING_WIDTH = 0.25;
/** Lift for decals drawn on the floor plane, to avoid z-fighting. */
export const DECAL_Y_OFFSET = 0.01;
/** Debug overlay sampling window, in frames. */
export const DEBUG_SAMPLE_FRAMES = 30;
/** Phase 0 acceptance: a dropped cube that falls, lands and comes to rest. */
export const TEST_CUBE_SIZE = 0.8;
export const TEST_CUBE_SPAWN = [3.0, 9.0, 6.0] as const;

// ---------------------------------------------------------------------------
// ADD-ON MODULE 01 — DRONE FPV CAMERA
//
// Presentation only. Nothing here reads or writes authoritative state, and the
// flight model is untouched: the drone flies identically in both camera modes.
// ---------------------------------------------------------------------------

/** Mount point on the drone body: forward 0.35 m, up 0.1 m. */
export const FPV_CAMERA_OFFSET = [0.0, 0.1, 0.35] as const;
/** Matches the third-person FOV — no field-of-view penalty for flying FPV. */
export const FPV_FOV = 90;
/** Hold longer than this to peek; a shorter tap latches the toggle. */
export const FPV_TOGGLE_HOLD_MS = 400;
export const FPV_TRANSITION_MS = 180;
/**
 * DIALLED DOWN BY THE DIRECTOR, twice. The module's values put a visible buzz
 * on the feed; these are roughly a quarter of that, so the camera reads as
 * mounted on a plastic object without making the picture hard to watch.
 */
export const FPV_SHAKE_VELOCITY_MULT = 0.005;
export const FPV_SHAKE_RPM_MULT = 0.002;
/** Shake frequency. Lower reads as a wobble; higher reads as a vibration. */
export const FPV_SHAKE_HZ = 6.5;
/**
 * How much of the drone's BODY TILT the camera inherits.
 *
 * The module says the camera is hard-parented with no stabilisation, and 1.0
 * is that. The director asked twice for a calmer feed, and body tilt (up to
 * TILT_MAX, 25 degrees) is by far the biggest contributor -- much more than the
 * shake. This softens it while keeping every bounce and bonk legible. Set to
 * 1.0 to restore the module's literal behaviour.
 */
export const FPV_TILT_INHERIT = 0.3;
/** Rolling-shutter skew ceiling. Lower if fast turns read as too smeary. */
export const FPV_MAX_SKEW = 0.05;
export const FPV_AUDIO_CROSSFADE_MS = 200;

/**
 * Feed treatment. Restrained by default: the arena is pastel and has to stay
 * readable, so this should say "obviously a camera feed" at a glance rather
 * than "broken television". Every effect is individually dial-able to zero.
 */
export const FPV_BARREL_DISTORTION = 0.18;
export const FPV_CHROMATIC_ABERRATION = 0.004;
export const FPV_SCANLINE_OPACITY = 0.06;
export const FPV_VIGNETTE = 0.35;
export const FPV_SENSOR_NOISE = 0.04;
export const FPV_ROLLING_SHUTTER = 0.12;
export const FPV_BLOOM_BOOST = 1.2;
/** Cyan lift in the shadows — the cheap-sensor look. */
export const FPV_SHADOW_TINT = [0.0, 0.045, 0.06] as const;
/** Scanline density, in lines across the vertical resolution. */
export const FPV_SCANLINE_DENSITY = 620;

/** The telegraph roughly doubles noise and skew. Atmosphere, not information. */
export const FPV_TELEGRAPH_EFFECT_MULT = 2.0;

/** localStorage key for the camera-mode preference. */
export const FPV_STORAGE_KEY = 'buzzkill.fpv';
