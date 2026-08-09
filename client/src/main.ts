import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import {
  ARENA_CEILING,
  ARENA_SIZE,
  CAMERA_DISTANCE,
  CAMERA_FOV,
  CAMERA_TARGET_HEIGHT,
  CHARGE_PAD_POSITIONS,
  CLIENT_SEND_HZ,
  CORES_REQUIRED,
  CORE_INSERT_HOLD,
  CORE_PICKUP_HOLD,
  CORE_PICKUP_RADIUS,
  DETONATION_RADIUS,
  EMP_STATION_POSITION,
  EMP_STATION_RADIUS,
  DRONE_CAMERA_DISTANCE,
  DRONE_CAMERA_HEIGHT,
  DRONE_CAMERA_LAG,
  EMP_FLASH_TIME,
  FIXED_TIMESTEP,
  KNOCKDOWN_RECOVERY,
  FOOT_OFFSET,
  FPV_STORAGE_KEY,
  FPV_TOGGLE_HOLD_MS,
  RUNNER_SPAWN,
} from '@shared/constants';

import { PropWhine, Sfx } from './engine/audio';
import { DebugOverlay } from './engine/debugOverlay';
import { Juice } from './engine/juice';
import { Input } from './engine/input';
import { Physics } from './engine/physics';
import { View } from './engine/view';
import { Arena } from './game/arena';
import { Autopilot } from './game/autopilot';
import { Bots } from './game/bots';
import { Character, loadCharacter, loadProps } from './game/character';
import { Confetti } from './game/confetti';
import { Drone } from './game/drone';
import { FollowCamera } from './game/followCamera';
import { FpvFeed } from './game/fpv';
import { Gremlin } from './game/gremlin';
import { Hazards } from './game/hazards';
import { Fuse, applyBlast } from '@shared/fuse';
import { Objective } from './game/objective';
import { Runner } from './game/runner';
import { SoloBots } from './game/soloBots';
import { TestCube } from './game/testCube';
import { Village, dressArena, dressStructures, loadVillage } from './game/village';
import { Connection, resolveEndpoint, type NetSnapshot } from './net/connection';
import { RemoteAvatars } from './net/remoteAvatars';
import { DevConsole } from './ui/devConsole';
import { FpvOverlay } from './ui/fpvOverlay';
import { Hud } from './ui/hud';
import { Lobby } from './ui/lobby';
import { Menu } from './ui/menu';
import { RoundSummaryPanel } from './ui/roundSummary';

const KEY_FORWARD = 'KeyW';
const KEY_BACK = 'KeyS';
const KEY_LEFT = 'KeyA';
const KEY_RIGHT = 'KeyD';
const KEY_JUMP = 'Space';
const KEY_DESCEND_LEFT = 'ShiftLeft';
const KEY_DESCEND_RIGHT = 'ShiftRight';
const KEY_DEBUG = 'Backquote';
const KEY_ORBIT = 'KeyO';
const KEY_SWAP = 'KeyC';
const KEY_RESPAWN = 'KeyR';
const KEY_DROP_CUBE = 'KeyB';
const KEY_INTERACT = 'KeyE';
const KEY_FPV = 'KeyV';
const KEY_SWAT = 'KeyF';
const KEY_THROW = 'KeyQ';
const KEY_GREMLIN = 'KeyG';
const KEY_DEV = 'Backslash';
const KEY_METRICS = 'KeyM';
const KEY_MENU = 'Escape';
/** Pickup clicks high, the insert clunk lands low. */
const CLICK_PITCH_PICKUP = 1.4;
const CLICK_PITCH_INSERT = 0.7;

/** Which body the player is currently piloting. */
type Pilot = 'runner' | 'drone';

/**
 * What the interact key would do right now, judged from server state.
 *
 * Online the server runs the objective, so it also owns whether a hold
 * succeeds. It does not tell you what is in reach, though, and a runner with
 * no prompt has no idea the key does anything — so the same reachability rule
 * is evaluated here purely to draw the prompt. It decides nothing.
 */
function reachableAction(
  snapshot: NetSnapshot,
  selfId: string,
  position: THREE.Vector3,
): 'pickup' | 'insert' | null {
  const me = snapshot.players.find((player) => player.sessionId === selfId);
  if (!me || me.role !== 'runner' || !me.alive) return null;

  if (me.carrying) {
    const reach = Math.hypot(
      position.x - EMP_STATION_POSITION[0],
      position.z - EMP_STATION_POSITION[1],
    );
    return reach <= EMP_STATION_RADIUS ? 'insert' : null;
  }

  const near = snapshot.cores.some(
    (core) =>
      (core.state === 'onPad' || core.state === 'loose') &&
      Math.hypot(position.x - core.x, position.z - core.z) <= CORE_PICKUP_RADIUS,
  );
  return near ? 'pickup' : null;
}

/** Radians of free-cam travel kept above the floor plane. */
const ORBIT_HORIZON_MARGIN = 0.08;

/** Dev-console teleport targets: the places a playtest keeps walking back to. */
const TELEPORTS: Record<string, readonly [number, number, number]> = {
  spawn: RUNNER_SPAWN,
  station: [EMP_STATION_POSITION[0], RUNNER_SPAWN[1], EMP_STATION_POSITION[1]],
  pad: [CHARGE_PAD_POSITIONS[0]![0], RUNNER_SPAWN[1], CHARGE_PAD_POSITIONS[0]![1]],
  ceiling: [0, ARENA_CEILING - 1, 0],
};

const HINTS: Record<Pilot, string> = {
  runner: 'RUNNER — WASD move · SPACE jump · C fly the drone · O free cam · ~ debug',
  drone: 'DRONE — WASD thrust · SPACE up · SHIFT down · C back to runner · O free cam · ~ debug',
};

async function boot(): Promise<void> {
  const physics = await Physics.create();
  const view = new View();
  const input = new Input(view.renderer.domElement);

  const arena = new Arena(physics, view.scene);
  const runner = new Runner(physics, view.scene);
  const drone = new Drone(physics, view.scene);
  const testCube = new TestCube(physics, view.scene);
  const camera = new FollowCamera(view.camera, physics);
  const fuse = new Fuse();
  const confetti = new Confetti(view.scene);
  const hud = new Hud();
  const whine = new PropWhine();
  const sfx = new Sfx();
  const objective = new Objective(view.scene);
  const autopilot = new Autopilot();
  const hazards = new Hazards(physics, view.scene);
  const gremlin = new Gremlin(view.scene);
  const juice = new Juice();
  const fpv = new FpvFeed(view.renderer);
  const fpvOverlay = new FpvOverlay();
  fpv.attachTo(drone.chassisObject);
  // Networking is optional: with no server configured this stays offline and
  // the whole single-player build behaves exactly as before.
  const net = new Connection();
  const avatars = new RemoteAvatars(view.scene);
  // Filler players, so a round can be played below the 3-human minimum. Only
  // the host ever ticks them; every other client just sees relayed avatars.
  const bots = new Bots();
  // Offline bots are real Runner bodies rather than relayed records: with no
  // server there is nothing to hold them, and half-simulated filler would make
  // solo a diorama instead of the game.
  const soloBots = new SoloBots(physics, view.scene);
  let soloBotCount = 0;
  const botInteract = new Map<string, boolean>();
  let botSendTimer = 0;
  let lastPhase = '';
  /** Session id of the bot flying the drone, when the host is simulating it. */
  let botDroneId = '';
  /**
   * Relayed runners, so the autopilot chases the whole room and not just us.
   * Mutable entries, refilled in place each frame.
   */
  const autopilotTargets: { alive: boolean; position: THREE.Vector3 }[] = [];
  /** The server's word on whether the drone is grounded, for prop wash. */
  let netDroneKnocked = false;
  /** Our own colourway, applied once rather than every frame. */
  let myColorway = -1;
  /** Local mirror of the server's hold timer, purely to fill the prompt bar. */
  let netHoldKind: 'pickup' | 'insert' | null = null;
  let netHoldTimer = 0;
  net.onDetonation = (message) => {
    // Server-declared detonation: same presentation as the local path, but the
    // kill list is the server's — this client decides nothing.
    confetti.burst(message);
    sfx.detonation();
    juice.detonation(
      runner.position.distanceTo(new THREE.Vector3(message.x, message.y, message.z)),
      DETONATION_RADIUS,
    );
    gremlin.onDetonation();
    if (message.victims.includes(net.sessionId)) {
      runner.eliminate();
      if (!gremlin.active) gremlin.enter(runner.position);
    }
  };

  const endpoint = resolveEndpoint();
  let soloMode = endpoint === '';
  const lobby = new Lobby({
    onCreate: (nickname) => {
      void net.connect(endpoint, nickname).then(() => {
        if (net.error) lobby.setServerUnreachable(net.error);
        else lobby.enterRoom();
      });
    },
    onJoin: (nickname, code) => {
      void net.joinByCode(endpoint, nickname, code).then(() => {
        if (net.error) lobby.setServerUnreachable(net.error);
        else lobby.enterRoom();
      });
    },
    onReady: (ready) => net.setReady(ready),
    onStart: () => net.start(),
    onSolo: (bots, asDrone) => {
      soloMode = true;
      soloBotCount = bots;
      // Rebuild the list the objective, the blast and the EMP charge all read,
      // so bots are participants rather than scenery.
      soloBots.setCount(bots, (bot) => {
        if (characterTemplate) bot.attachCharacter(new Character(characterTemplate, characterClips));
      });
      runners.length = 1;
      for (let i = 0; i < bots; i += 1) {
        const bot = soloBots.runners[i];
        if (bot) runners.push(bot);
      }
      washTargets.length = 0;
      washTargets.push(...runners);
      // Picking "fly" hands the runner to the autopilot's quarry list and puts
      // you in the drone; picking "run" leaves the drone on autopilot, which
      // is the bot drone.
      pilot = asDrone ? 'drone' : 'runner';
      camera.reset();
      if (asDrone) camera.setYaw(drone.yaw);
      setHint();
    },
    onPractice: (on) => net.setPractice(on),
    onRole: (role) => net.setRole(role),
    onBots: (count) => net.setBots(count),
    onLeave: () => {
      void net.leave();
      lobby.returnToLanding(endpoint === '');
    },
  });
  const menu = new Menu({
    onResume: () => undefined,
    onQuit: () => {
      // Leave whatever we are in and go back to the start. Offline this is
      // just a screen change; online it also hands the room back.
      void net.leave();
      soloBotCount = 0;
      soloBots.setCount(0, () => undefined);
      runners.length = 1;
      washTargets.length = 0;
      washTargets.push(runner);
      pilot = 'runner';
      camera.reset();
      setHint();
      lobby.returnToLanding(endpoint === '');
    },
    onToggleFpv: () => {
      fpvMode = !fpvMode;
      window.localStorage.setItem(FPV_STORAGE_KEY, fpvMode ? '1' : '0');
    },
    onToggleHazards: () => {
      hazards.setEnabled(!hazards.isEnabled);
      return hazards.isEnabled;
    },
    onRespawn: () => {
      runner.respawn();
      gremlin.exit();
    },
  });

  // With no server configured there is nothing to join — but the solo setup
  // still has to be reachable, so show the landing card with only that on it.
  if (soloMode) lobby.setSoloOnly();
  else lobby.setStatus(`server: ${endpoint}`);

  // Test tooling, and only ever tooling: a production build sets neither of
  // these, so the console is not constructed and its module drops out.
  const devEnabled = import.meta.env.DEV || import.meta.env.VITE_DEV_CONSOLE === '1';
  const summaryPanel = devEnabled ? new RoundSummaryPanel() : null;
  if (summaryPanel) net.onRoundEnd = (summary) => summaryPanel.record(summary);
  const devConsole = devEnabled
    ? new DevConsole({
        send: (action, value) => net.sendDev(action, value),
        teleport: (where) => {
          const spot = TELEPORTS[where] ?? RUNNER_SPAWN;
          runner.moveTo(spot[0], spot[1], spot[2]);
        },
        toggleHazards: () => {
          hazards.setEnabled(!hazards.isEnabled);
          return hazards.isEnabled;
        },
        localBattery: (charge) => { fuse.charge = charge; },
        localCycle: (cycle) => {
          fuse.cycle = cycle;
          fuse.charge = 1;
          fuse.state = 'armed';
        },
      })
    : null;

  // The character model loads in the background. The game is playable from the
  // first frame with primitive bodies and upgrades in place when it arrives —
  // a 134 kB decoration must never hold up the thing it decorates.
  let characterTemplate: THREE.Object3D | null = null;
  let characterClips: THREE.AnimationClip[] = [];
  void loadCharacter().then(({ scene, animations }) => {
    if (!scene) return;
    characterTemplate = scene;
    characterClips = animations;
    avatars.setCharacterTemplate(scene, animations);
    runner.attachCharacter(new Character(scene, animations));
    // Bots chosen before the model landed get their body now.
    for (const bot of soloBots.runners) bot.attachCharacter(new Character(scene, animations));
  });
  void loadProps().then((props) => hazards.setPropModels(props));
  // Set dressing. Loaded last and never awaited: the arena is the game, the
  // village is what it stands in, and one must not delay the other. The
  // structures pass dresses the greybox colliders in kit meshes (session 8);
  // the arena pass scatters the decoration around them.
  void loadVillage().then((pieces) => {
    const village = new Village(view.scene);
    dressStructures(village, pieces, arena, hazards);
    dressArena(village, pieces);
  });

  const sizeFpv = (): void => fpv.resize(window.innerWidth, window.innerHeight);
  sizeFpv();
  window.addEventListener('resize', sizeFpv);

  // Browsers will not start audio without a gesture, and the prop whine is a
  // mechanic rather than polish, so wire it to the first interaction there is.
  const startAudio = (): void => {
    whine.start();
    sfx.attach(whine.audioContext);
  };
  window.addEventListener('pointerdown', startAudio);
  window.addEventListener('keydown', startAudio);

  // Free camera, for inspecting the arena and comparing the runner and drone
  // views in one build (phase 2 task list).
  const orbit = new OrbitControls(view.camera, view.renderer.domElement);
  orbit.enabled = false;
  orbit.target.set(0, 0, 0);
  orbit.maxDistance = ARENA_SIZE;
  // Stop just short of the horizon: dragging past it puts the camera under the
  // floor, where the arena is an opaque slab and it looks like the renderer has
  // broken. Caught me twice while taking screenshots for these sessions.
  orbit.maxPolarAngle = Math.PI / 2 - ORBIT_HORIZON_MARGIN;

  const debugElement = document.getElementById('debug');
  const hintElement = document.getElementById('hint');
  const bootElement = document.getElementById('boot');
  if (!debugElement) throw new Error('debug overlay element missing');
  const overlay = new DebugOverlay(debugElement);
  if (bootElement) bootElement.hidden = true;

  const moveInput = new THREE.Vector2();
  const droneInput = { move: new THREE.Vector2(), lift: 0 };
  const lookAt = new THREE.Vector3();
  const washTargets = [runner];

  let pilot: Pilot = 'runner';
  let orbitMode = false;
  let interactHeld = false;
  let gremlinLift = 0;
  let lastInserted = 0;
  let lastCarrying = false;
  /** Insert count when carrying last changed, to tell a delivery from a drop. */
  let lastInsertedForCarry = 0;
  const testScript: { n: number; x: number; y: number; lift: number }[] = [];
  const testInput = { move: new THREE.Vector2(), lift: 0 };
  const testEndPos = new THREE.Vector3();

  // Dev-only measurement hooks. Vite strips this whole block from production
  // builds, so nothing here can leak into a real match.
  if (import.meta.env.DEV) {
    (window as unknown as { __test?: object }).__test = {
      resetDrone: () => drone.resetForTest(),
      placeDrone: (x: number, y: number, z: number) => drone.placeAt(x, y, z),
      moveRunner: (x: number, y: number, z: number) => runner.moveTo(x, y, z),
      grounded: () => runner.grounded,
      dronePos: () => ({ x: drone.position.x, y: drone.position.y, z: drone.position.z }),
      runnerPos: () => ({ x: runner.position.x, y: runner.position.y, z: runner.position.z }),
      fly: (steps: { n: number; x: number; y: number; lift: number }[]) => {
        testScript.length = 0;
        for (const step of steps) testScript.push({ ...step });
      },
      scriptDone: () => testScript.length === 0,
      endPos: () => ({ x: testEndPos.x, y: testEndPos.y, z: testEndPos.z }),
      // What is actually being drawn. Online there must be exactly one drone
      // and one set of cores; a duplicated local copy shows up here as a
      // non-zero localCores or a visible local drone that nobody is flying.
      dressed: () => arena.dressedReport(),
      census: () => ({
        localCores: objective.cores.filter((core) => core.mesh.visible).length,
        localCorePositions: objective.cores.map((core) => [
          core.mesh.position.x,
          core.mesh.position.y,
          core.mesh.position.z,
        ]),
        localDroneVisible: drone.object.visible,
        localDroneSimulating: drone.isActive,
        localShafts: objective.cores.filter((core) => core.shaft.visible).length,
        haloArc: drone.haloArcTurns,
        botDroneId,
        soloBots: soloBots.runners.slice(0, soloBotCount).map((bot) => ({
          alive: bot.alive,
          carrying: bot.carrying,
          interacting: bot.interacting,
          x: +bot.position.x.toFixed(1),
          z: +bot.position.z.toFixed(1),
          triggers: soloBots.stuckTriggers[soloBots.runners.indexOf(bot)] ?? 0,
          station: +Math.hypot(
            bot.position.x - EMP_STATION_POSITION[0],
            bot.position.z - EMP_STATION_POSITION[1],
          ).toFixed(2),
          speed: +bot.intentSpeed.toFixed(2),
        })),
        ...avatars.census(),
      }),
    };
  }
  let roundClock = 0;
  let empFlash = 0;
  const runners: Runner[] = [runner];

  // FPV mode: a tap latches the toggle, a hold peeks and reverts on release.
  let fpvMode = window.localStorage.getItem(FPV_STORAGE_KEY) === '1';
  let fpvPressedAt = 0;
  let fpvBeforePeek = fpvMode;

  function setHint(): void {
    if (!hintElement) return;
    hintElement.textContent = orbitMode
      ? 'FREE CAM — drag to look · O to return'
      : HINTS[pilot];
  }
  setHint();

  physics.onFixedStep((dt) => {
    roundClock += dt;

    // Both bodies always simulate. When the player is on foot the drone is
    // flown by the phase 4 script, so the objective always has pressure on it.
    runner.fixedUpdate(dt, moveInput, camera.heading);
    // Offline only: online the server owns every other body.
    if (!net.connected && soloBotCount > 0) soloBots.fixedUpdate(dt, objective, soloBotCount);

    // Online the autopilot flies the bot drone against everyone in the room;
    // offline it flies the phase 4 scripted drone against the local runner.
    const quarry = net.connected ? autopilotTargets : runners;
    let flown = pilot === 'drone' ? droneInput : autopilot.update(drone.position, quarry);
    if (testScript.length > 0) {
      // Deterministic scripted input (dev-only hook): consumed in fixed steps,
      // so frame rate cannot smear the sequence. Used for FPV parity proof.
      const step = testScript[0]!;
      testInput.move.set(step.x, step.y);
      testInput.lift = step.lift;
      flown = testInput;
      step.n -= 1;
      if (step.n <= 0) {
        testScript.shift();
        // Capture at the exact step the script empties: sampling later on the
        // wall clock reads a still-coasting drone at whatever sim time the
        // poll happens to land on, which is frame-rate noise, not physics.
        if (testScript.length === 0) testEndPos.copy(drone.position);
      }
    } else if (pilot !== 'drone' && fuse.piloted) {
      drone.steerTowards(autopilot.yaw, dt);
    }
    drone.fixedUpdate(dt, flown, fuse);

    // Prop wash is applied here, not inside the drone, so that a client with
    // no drone body of its own still feels it: `drone.position` mirrors the
    // relayed drone, and shoving our own runner from it is ours to do.
    // Rotors turn only while the drone is piloted and on its feet.
    const droneDown = net.connected ? netDroneKnocked : drone.knocked || drone.isDead;
    if (fuse.piloted && !droneDown) drone.applyPropWash(dt, washTargets);

    // Online the shove flag has no local objective to consume it, so read it
    // here and let the server decide what it costs us.
    if (net.connected && runner.consumeShoved()) net.reportShoved();
    for (let i = hazards.consumeSabotages(); i > 0; i -= 1) net.reportSabotage();

    // SACRED CONSTRAINT 3: when a server is connected, the battery lives there
    // and only there, so the local fuse and the blast it causes are strictly
    // offline — without this gate the client computes a parallel detonation
    // while online, which is exactly what the constraint forbids. Everything
    // below it still runs online: hazards and the gremlin are how a runner
    // acts on the world, and the server owns their consequences, not the act.
    if (!net.connected) {
      // The battery is the only thing that can trigger a detonation — sacred
      // constraint 2 — so the blast is a consequence of this step, not an action.
      const detonation = fuse.step(dt, drone.position, drone.settled, objective.availablePads());
      if (detonation) {
        applyBlast(detonation.position, runners);
        confetti.burst(detonation.position);
        sfx.detonation();
        juice.detonation(runner.position.distanceTo(detonation.position as THREE.Vector3), DETONATION_RADIUS);
        // Being blown up hands you a gremlin, and every detonation refreshes
        // the one hazard trigger a gremlin gets.
        gremlin.onDetonation();
        if (!runner.alive && !gremlin.active) gremlin.enter(runner.position);
      }
    }

    hazards.fixedUpdate(dt, runner, drone, interactHeld);
    hazards.checkPropHits(drone);
    if (hazards.knockdownRequested) {
      hazards.knockdownRequested = false;
      juice.knockdown();
      // Sacred constraint 4: a knockdown costs the drone time, never its life.
      drone.knockdown(KNOCKDOWN_RECOVERY);
      net.reportKnockdown();
    }

    // Eliminated: fly the gremlin instead of the runner.
    if (gremlin.active) gremlin.fixedUpdate(dt, moveInput, gremlinLift, camera.heading);

    // Offline the local objective IS the objective. Online the server runs it
    // and this copy would only fight it, so the prompt is derived from the
    // snapshot instead (see promptFor) and nothing here steps.
    if (net.connected) return;
    runner.interacting = interactHeld;
    objective.step(dt, runners);
    if (objective.fired && empFlash === 0) {
      juice.empFired();
      // Runners win the moment the EMP fires. The drone drops dead.
      empFlash = EMP_FLASH_TIME;
      drone.kill();
    }
  });
  physics.onFixedPostStep(() => {
    drone.sample();
    testCube.sample();
    hazards.sample();
  });

  let lastFrameTime = performance.now();

  // A backgrounded tab hands back one enormous delta; drop it rather than
  // trying to catch up 30 s of simulation in a single frame.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      physics.resetAccumulator();
      lastFrameTime = performance.now();
    }
  });

  function frame(now: number): void {
    const realDelta = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    // Hit stop scales the whole world's clock for a few milliseconds.
    const frameDelta = juice.consumeHitstop(realDelta);

    if (input.consumePress(KEY_MENU)) menu.toggle();
    if (input.consumePress(KEY_DEBUG)) overlay.toggle();
    if (devConsole && input.consumePress(KEY_DEV)) {
      devConsole.toggle();
      if (devConsole.visible) document.exitPointerLock();
    }
    if (summaryPanel && input.consumePress(KEY_METRICS)) {
      summaryPanel.toggle();
      document.exitPointerLock();
    }
    // Offline you can swap bodies freely, which is how the single-player build
    // lets one person feel both sides. Online the server assigns the role.
    if (input.consumePress(KEY_SWAP) && !net.connected) {
      pilot = pilot === 'runner' ? 'drone' : 'runner';
      camera.reset();
      if (pilot === 'drone') camera.setYaw(drone.yaw);
      setHint();
    }
    if (input.consumePress(KEY_ORBIT)) {
      orbitMode = !orbitMode;
      orbit.enabled = orbitMode;
      if (orbitMode) {
        document.exitPointerLock();
        orbit.target.copy(pilot === 'drone' ? drone.object.position : runner.object.position);
      } else {
        camera.reset();
      }
      setHint();
    }
    if (input.consumePress(KEY_FPV)) {
      fpvBeforePeek = fpvMode;
      fpvPressedAt = now;
      fpvMode = !fpvMode;
    }
    if (fpvPressedAt > 0 && !input.isHeld(KEY_FPV)) {
      // Held long enough to count as a peek: snap back to where we were.
      if (now - fpvPressedAt >= FPV_TOGGLE_HOLD_MS) fpvMode = fpvBeforePeek;
      fpvPressedAt = 0;
      window.localStorage.setItem(FPV_STORAGE_KEY, fpvMode ? '1' : '0');
    }
    if (input.consumePress(KEY_RESPAWN)) {
      runner.respawn();
      gremlin.exit();
    }
    // Gremlins climb and dive with the same keys the drone uses.
    gremlinLift = gremlin.active
      ? (input.isHeld(KEY_JUMP) ? 1 : 0)
        - (input.isHeld(KEY_DESCEND_LEFT) || input.isHeld(KEY_DESCEND_RIGHT) ? 1 : 0)
      : 0;
    if (gremlin.active && input.consumePress(KEY_GREMLIN)) {
      gremlin.trigger('smoke', drone.position);
    }
    if (input.consumePress(KEY_DROP_CUBE)) testCube.drop();

    moveInput.set(0, 0);
    droneInput.move.set(0, 0);
    droneInput.lift = 0;
    interactHeld = !orbitMode && pilot === 'runner' && input.isHeld(KEY_INTERACT);

    if (!orbitMode) {
      const strafe = (input.isHeld(KEY_RIGHT) ? 1 : 0) - (input.isHeld(KEY_LEFT) ? 1 : 0);
      const forward = (input.isHeld(KEY_FORWARD) ? 1 : 0) - (input.isHeld(KEY_BACK) ? 1 : 0);

      if (pilot === 'runner') {
        moveInput.set(strafe, forward);
        if (input.pointerLocked) camera.look(input.mouseDeltaX, input.mouseDeltaY);
        if (input.consumePress(KEY_JUMP)) runner.queueJump();
        if (input.consumePress(KEY_SWAT)) {
          // The swing plays whether or not it lands: a whiff you cannot see is
          // indistinguishable from an input that was dropped. The connect gets
          // its own heavier sound so a hit and a miss are told apart by ear.
          runner.playSwat();
          if (hazards.swat(runner, drone, camera.heading)) {
            juice.swatConnected();
            sfx.thud();
          } else {
            sfx.whoosh();
          }
        }
        if (input.consumePress(KEY_THROW)) hazards.toggleProp(runner, camera.heading);
      } else {
        droneInput.move.set(strafe, forward);
        const descending = input.isHeld(KEY_DESCEND_LEFT) || input.isHeld(KEY_DESCEND_RIGHT);
        droneInput.lift = (input.isHeld(KEY_JUMP) ? 1 : 0) - (descending ? 1 : 0);
        // The mouse turns the drone; the camera just follows its heading.
        if (input.pointerLocked) {
          drone.look(input.mouseDeltaX);
          camera.look(0, input.mouseDeltaY);
          camera.setYaw(drone.yaw);
        }
      }
    }

    physics.advance(frameDelta);

    // Server-authoritative state, rendered verbatim and never recomputed.
    // Read before anything draws, because online it decides what is drawn:
    // who is flying, where the cores are, and which pads are blocked.
    const snapshot = net.snapshot();
    if (snapshot) {
      lobby.update(snapshot, net.sessionId);
      avatars.update(snapshot, net.sessionId, frameDelta);
      fuse.charge = snapshot.battery;
      fuse.cycle = snapshot.cycle;
      fuse.state = snapshot.fuseState as typeof fuse.state;
      netDroneKnocked = snapshot.droneKnocked;
      // The server assigns roles, so online the pilot is not ours to choose:
      // whoever it says is the drone flies, and every other client stows its
      // local copy of the drone rather than simulating a second one.
      const me = snapshot.players.find((player) => player.sessionId === net.sessionId);
      if (me && me.colorway !== myColorway) {
        myColorway = me.colorway;
        runner.setColorway(myColorway);
      }
      const playing = snapshot.phase === 'playing';
      const flying = me?.role === 'drone' && playing;
      if (flying !== (pilot === 'drone')) {
        pilot = flying ? 'drone' : 'runner';
        camera.reset();
        if (flying) camera.setYaw(drone.yaw);
        setHint();
      }

      // A bot in the pilot seat is flown by the host, using the same physics
      // body and the same autopilot the offline build uses — so a bot drone
      // handles exactly as badly as a real one, which is the whole game.
      const botDrone = snapshot.players.find((player) => player.role === 'drone' && player.bot);
      const hostFliesBot = Boolean(botDrone) && snapshot.host === net.sessionId && playing;
      botDroneId = hostFliesBot ? (botDrone?.sessionId ?? '') : '';

      // Simulate when we are flying, or when we are the host flying a bot.
      // Only draw the local body when it is ours: the bot's is drawn from the
      // relay, the same copy every other client sees.
      drone.setActive(flying || hostFliesBot, flying);

      // Stowed but not gone: the local drone's position tracks the relayed one
      // so every range check a runner makes — swat, thrown prop, ceiling fan —
      // and the prop whine's panning all target the drone that really exists.
      if (!flying && !hostFliesBot && avatars.droneTracked) {
        drone.position.copy(avatars.dronePosition);
        drone.object.position.copy(avatars.dronePosition);
      }
      objective.setCoresVisible(false);

      // Reuse the entries rather than rebuilding them: this runs every frame,
      // and allocating a vector per player per frame is pure garbage churn.
      let target = 0;
      for (const player of snapshot.players) {
        if (player.role !== 'runner') continue;
        let slot = autopilotTargets[target];
        if (!slot) {
          slot = { alive: true, position: new THREE.Vector3() };
          autopilotTargets.push(slot);
        }
        slot.alive = player.alive;
        slot.position.set(player.x, player.y, player.z);
        target += 1;
      }
      autopilotTargets.length = target;

      if (snapshot.phase !== lastPhase) {
        lastPhase = snapshot.phase;
        // A fresh round puts the bots back on the start line, and clears the
        // edge-triggered interact state so the first hold is sent again.
        bots.reset();
        botInteract.clear();
        if (snapshot.phase === 'playing') runner.respawn();
      }

      // Only the host ticks the bots. Every client running them would relay
      // conflicting positions for the same bodies, and the server takes bot
      // moves from the host alone anyway.
      if (snapshot.host === net.sessionId && snapshot.phase === 'playing') {
        const commands = bots.update(frameDelta, snapshot);
        botSendTimer += frameDelta;
        // Positions go out at the same rate as a human's, so bots cost the
        // same bandwidth as the players they stand in for.
        const due = botSendTimer >= 1 / CLIENT_SEND_HZ;
        if (due) botSendTimer = 0;
        for (const command of commands) {
          if (due) net.sendBotMove(command.id, command.x, command.y, command.z, command.yaw);
          if (botInteract.get(command.id) !== command.interacting) {
            botInteract.set(command.id, command.interacting);
            net.sendBotInteract(command.id, command.interacting);
          }
        }
        // The bot drone rides the same relay as the bot runners; its body is
        // the local Rapier one, so the server sees a real flight path.
        if (due && botDroneId) {
          net.sendBotMove(
            botDroneId,
            drone.position.x,
            drone.position.y,
            drone.position.z,
            drone.yaw,
          );
        }
      }
    } else if (net.error) {
      avatars.clear();
    }
    devConsole?.setContext(snapshot !== null, snapshot?.devEnabled ?? false);

    runner.render(physics.alpha, frameDelta, interactHeld, camera.heading);
    drone.render(physics.alpha, frameDelta, fuse.telegraphProgress, fuse.charge);
    arena.render(frameDelta);

    // Pad colours are the board state at a glance: green free, red core-blocked,
    // blue drone docked, grey sabotaged.
    const dockedPad = fuse.pad;
    const sabotaged = new Set(hazards.disabledPadIndices());
    // Online the server's cores decide which pads are denied; offline the
    // local ones do. Same rule, one source of truth at a time.
    const blockedPads = snapshot
      ? new Set(
          snapshot.cores
            .filter((core) => (core.state === 'onPad' || core.state === 'loose') && core.pad >= 0)
            .map((core) => core.pad),
        )
      : null;
    for (let i = 0; i < CHARGE_PAD_POSITIONS.length; i += 1) {
      const pad = CHARGE_PAD_POSITIONS[i]!;
      const blocked = blockedPads
        ? blockedPads.has(i)
        : !objective.availablePads().some((free) => free[0] === pad[0] && free[1] === pad[1]);
      const docked = fuse.state === 'recharging' && dockedPad?.[0] === pad[0] && dockedPad[1] === pad[1];
      arena.setPadState(
        i,
        sabotaged.has(i) ? 'sabotaged' : docked ? 'docked' : blocked ? 'blocked' : 'available',
      );
    }
    testCube.render(physics.alpha);
    objective.render(frameDelta);
    hazards.render(physics.alpha, frameDelta, runner);
    gremlin.render(frameDelta);
    confetti.update(frameDelta);
    hud.update(fuse);
    // Only a runner needs the warning: the pilot knows exactly where it is.
    hud.updateProximity(
      pilot === 'drone' ? Infinity : runner.position.distanceTo(drone.position),
      frameDelta,
      runner.alive,
    );
    whine.update(
      drone.object.position,
      view.camera,
      drone.throttleLevel,
      fuse.telegraphProgress,
      !fuse.piloted && fuse.state !== 'returning',
    );

    const showFpv = pilot === 'drone' && fpvMode && !orbitMode;
    fpv.update(
      frameDelta,
      drone.velocity,
      drone.yawRate,
      drone.throttleLevel,
      fuse.telegraphProgress,
      showFpv,
      drone.pitchAngle,
      drone.rollAngle,
    );
    fpvOverlay.setVisible(fpv.visible);
    if (fpv.visible) {
      fpvOverlay.update(
        fuse,
        drone.position.y,
        drone.speed,
        drone.pitchAngle,
        drone.rollAngle,
        roundClock,
      );
    }

    if (orbitMode) {
      orbit.update();
    } else if (pilot === 'runner') {
      lookAt.set(
        runner.object.position.x,
        runner.object.position.y - FOOT_OFFSET + CAMERA_TARGET_HEIGHT,
        runner.object.position.z,
      );
      camera.update(frameDelta, lookAt, runner.characterCollider);
    } else {
      lookAt.copy(drone.object.position).setY(drone.object.position.y + DRONE_CAMERA_HEIGHT);
      camera.update(
        frameDelta,
        lookAt,
        drone.hullCollider,
        DRONE_CAMERA_DISTANCE,
        DRONE_CAMERA_LAG,
      );
    }

    juice.apply(view.camera, realDelta, CAMERA_FOV);

    overlay.setExtraLines([
      `piloting     ${orbitMode ? 'free cam (debug)' : pilot}`,
      `network      ${net.connected ? `online (${net.sessionId.slice(0, 6)})` : net.error ?? 'offline — single player'}`,
      `latency      ${net.rtt === null ? '—' : `${net.rtt} ms RTT · server sees you up to ` +
        `${net.positionLagMetres?.toFixed(2)} m behind (blast radius ${DETONATION_RADIUS})`}`,
      `sim clock    ${(physics.totalSteps * FIXED_TIMESTEP).toFixed(2)}s  (${physics.totalSteps} steps)`,
      `fuse         ${fuse.state}  cycle ${fuse.cycle + 1}  charge ${(fuse.charge * 100).toFixed(1)}%` +
        `  ${fuse.secondsRemaining.toFixed(1)}s left`,
      `runner       ${runner.alive ? 'alive' : 'ELIMINATED'}${runner.carrying ? ' CARRYING' : ''}` +
        `   audio ${whine.running ? 'on' : 'off (click)'}`,
      `objective    cores ${snapshot ? snapshot.coresInserted : objective.status().inserted}` +
        `/${CORES_REQUIRED}` +
        `  charge ${((snapshot ? snapshot.empCharge : objective.charge) * 100).toFixed(1)}%` +
        `  in zone ${snapshot ? snapshot.empPresent : objective.status().present}` +
        `/${snapshot ? snapshot.empNeeded : objective.status().needed}` +
        `${(snapshot ? snapshot.winner === 'runners' : objective.fired) ? '  EMP FIRED — RUNNERS WIN' : ''}`,
      `gremlin      ${gremlin.status().active ? `flying · triggers ${gremlin.status().actionsLeft}` : 'inactive'}` +
        `${gremlin.status().blocked ? ` (${gremlin.status().blocked})` : ''}`,
      `hazards      swat ${hazards.status().swatCooldown.toFixed(1)}s` +
        `  prop ${hazards.status().holdingProp ? 'held' : '-'}` +
        `  net ${hazards.status().netSlow > 0 ? 'TANGLED' : '-'}` +
        `  knocked ${drone.knocked ? 'YES' : 'no'}` +
        `  sabotaged [${hazards.disabledPadIndices().join(',')}]`,
      `pads free    ${blockedPads ? CHARGE_PAD_POSITIONS.length - blockedPads.size : objective.availablePads().length}` +
        `/${CHARGE_PAD_POSITIONS.length}` +
        `   camera ${fpvMode && pilot === 'drone' ? 'FPV' : 'chase'}`,
      ...runner.debugLines(),
      ...drone.debugLines(),
      `cube y       ${testCube.height.toFixed(2)}  ${testCube.isAsleep ? '(asleep)' : '(awake)'}`,
      `camera       boom ${camera.boomLength.toFixed(2)} / ${CAMERA_DISTANCE.toFixed(1)} m`,
      `draw calls   ${view.renderer.info.render.calls}   tris ${view.renderer.info.render.triangles}`,
      '',
      'E interact · F swat · Q grab/throw · G gremlin · C swap · V FPV · R respawn · O free cam'
        + (devConsole ? ' · \\ dev console · M round metrics' : ''),
    ]);
    overlay.update(frameDelta, physics);

    net.update(
      frameDelta,
      pilot === 'drone'
        ? { x: drone.position.x, y: drone.position.y, z: drone.position.z, yaw: drone.yaw }
        : { x: runner.position.x, y: runner.position.y, z: runner.position.z, yaw: camera.heading },
      interactHeld,
    );

    if (empFlash > 0) empFlash = Math.max(0, empFlash - frameDelta);
    // The hold prompt is a local affordance and stays local; the numbers it
    // sits under are the server's whenever there is one (sacred constraint 3
    // is about battery, but the same reasoning covers cores and the EMP).
    const local = objective.status(runner);
    let status = local;
    if (snapshot) {
      const action = snapshot.phase === 'playing'
        ? reachableAction(snapshot, net.sessionId, runner.position)
        : null;
      // Reset on any change of target, so the bar never carries progress from
      // one hold into the next.
      if (action !== netHoldKind) {
        netHoldKind = action;
        netHoldTimer = 0;
      }
      netHoldTimer = action && interactHeld ? netHoldTimer + frameDelta : 0;
      const duration = action === 'insert' ? CORE_INSERT_HOLD : CORE_PICKUP_HOLD;

      status = {
        ...local,
        inserted: snapshot.coresInserted,
        required: CORES_REQUIRED,
        charge: snapshot.empCharge,
        charging: snapshot.coresInserted >= CORES_REQUIRED,
        present: snapshot.empPresent,
        needed: snapshot.empNeeded,
        fired: snapshot.winner === 'runners',
        prompt: action === 'insert'
          ? `hold E to insert core (${snapshot.coresInserted + 1}/${CORES_REQUIRED})`
          : action === 'pickup' ? 'hold E to pick up core' : null,
        holdProgress: action ? Math.min(netHoldTimer / duration, 1) : 0,
      };
    }
    hud.updateObjective(status, empFlash / EMP_FLASH_TIME);
    sfx.setEmpCharge(status.fired ? 0 : status.charge);
    // Core count changing is the cue for the insert clunk.
    if (status.inserted !== lastInserted) {
      lastInserted = status.inserted;
      sfx.click(CLICK_PITCH_INSERT);
    }
    // Online the server says who is carrying; offline our own body does.
    const carrying = snapshot
      ? (snapshot.players.find((player) => player.sessionId === net.sessionId)?.carrying ?? false)
      : runner.carrying;
    if (carrying !== lastCarrying) {
      // Losing a core has to sound like a loss. Without this a runner blown
      // off a pad keeps running for the station with empty hands.
      const inserted = status.inserted > lastInsertedForCarry;
      lastInsertedForCarry = status.inserted;
      if (carrying) sfx.click(CLICK_PITCH_PICKUP);
      else if (!inserted) sfx.fumble();
      lastCarrying = carrying;
    }

    input.endFrame();
    if (fpv.visible) {
      // Looking out of the drone, not at it.
      drone.setBodyVisible(false);
      fpv.render(view.scene);
      drone.setBodyVisible(true);
    } else {
      view.render();
    }
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

void boot().catch((error: unknown) => {
  const bootElement = document.getElementById('boot');
  if (bootElement) {
    bootElement.hidden = false;
    bootElement.textContent = `BUZZKILL FAILED TO START — ${String(error)}`;
  }
  console.error(error);
});
