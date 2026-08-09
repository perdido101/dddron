import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import {
  ARENA_SIZE,
  CAMERA_DISTANCE,
  CAMERA_FOV,
  CAMERA_TARGET_HEIGHT,
  DETONATION_RADIUS,
  DRONE_CAMERA_DISTANCE,
  DRONE_CAMERA_HEIGHT,
  DRONE_CAMERA_LAG,
  EMP_FLASH_TIME,
  FIXED_TIMESTEP,
  KNOCKDOWN_RECOVERY,
  FOOT_OFFSET,
  FPV_STORAGE_KEY,
  FPV_TOGGLE_HOLD_MS,
} from '@shared/constants';

import { PropWhine, Sfx } from './engine/audio';
import { DebugOverlay } from './engine/debugOverlay';
import { Juice } from './engine/juice';
import { Input } from './engine/input';
import { Physics } from './engine/physics';
import { View } from './engine/view';
import { Arena } from './game/arena';
import { Autopilot } from './game/autopilot';
import { Confetti } from './game/confetti';
import { Drone } from './game/drone';
import { FollowCamera } from './game/followCamera';
import { FpvFeed } from './game/fpv';
import { Gremlin } from './game/gremlin';
import { Hazards } from './game/hazards';
import { Fuse, applyBlast } from '@shared/fuse';
import { Objective } from './game/objective';
import { Runner } from './game/runner';
import { TestCube } from './game/testCube';
import { Connection, resolveEndpoint } from './net/connection';
import { RemoteAvatars } from './net/remoteAvatars';
import { FpvOverlay } from './ui/fpvOverlay';
import { Hud } from './ui/hud';
import { Lobby } from './ui/lobby';

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
/** Pickup clicks high, the insert clunk lands low. */
const CLICK_PITCH_PICKUP = 1.4;
const CLICK_PITCH_INSERT = 0.7;

/** Which body the player is currently piloting. */
type Pilot = 'runner' | 'drone';

const HINTS: Record<Pilot, string> = {
  runner: 'RUNNER — WASD move · SPACE jump · C fly the drone · O free cam · ~ debug',
  drone: 'DRONE — WASD thrust · SPACE up · SHIFT down · C back to runner · O free cam · ~ debug',
};

async function boot(): Promise<void> {
  const physics = await Physics.create();
  const view = new View();
  const input = new Input(view.renderer.domElement);

  new Arena(physics, view.scene);
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
  net.onDetonation = (message) => confetti.burst(message);

  const endpoint = resolveEndpoint();
  let soloMode = endpoint === '';
  const lobby = new Lobby({
    onCreate: (nickname) => {
      void net.connect(endpoint, nickname).then(() => {
        if (net.error) lobby.setStatus(net.error);
        else lobby.enterRoom();
      });
    },
    onJoin: (nickname, code) => {
      void net.joinByCode(endpoint, nickname, code).then(() => {
        if (net.error) lobby.setStatus(net.error);
        else lobby.enterRoom();
      });
    },
    onReady: (ready) => net.setReady(ready),
    onStart: () => net.start(),
    onSolo: () => { soloMode = true; },
  });
  // With no server configured there is nothing to join, so go straight in.
  if (soloMode) lobby.hide();
  else lobby.setStatus(`server: ${endpoint}`);

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
  let roundClock = 0;
  let empFlash = 0;
  const runners = [runner];

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

    const flown = pilot === 'drone' ? droneInput : autopilot.update(drone.position, runners);
    if (pilot !== 'drone' && fuse.piloted) drone.steerTowards(autopilot.yaw, dt);
    drone.fixedUpdate(dt, flown, washTargets, fuse);

    // The battery is the only thing that can trigger a detonation — sacred
    // constraint 2 — so the blast is a consequence of this step, not an action.
    const detonation = fuse.step(dt, drone.position, drone.settled, objective.availablePads());
    if (detonation) {
      applyBlast(detonation.position, runners);
      confetti.burst(detonation.position);
      sfx.detonation();
      juice.detonation(runner.position.distanceTo(detonation.position as THREE.Vector3), DETONATION_RADIUS);
      // Being blown up hands you a gremlin, and every detonation refreshes the
      // one hazard trigger a gremlin gets.
      gremlin.onDetonation();
      if (!runner.alive && !gremlin.active) gremlin.enter(runner.position);
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

    objective.step(dt, runners, interactHeld);
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

    if (input.consumePress(KEY_DEBUG)) overlay.toggle();
    if (input.consumePress(KEY_SWAP)) {
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
        if (input.consumePress(KEY_SWAT) && hazards.swat(runner, drone, camera.heading)) {
          juice.swatConnected();
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

    runner.render(physics.alpha, frameDelta);
    drone.render(physics.alpha, frameDelta, fuse.telegraphProgress);
    testCube.render(physics.alpha);
    hazards.render(physics.alpha, frameDelta, runner);
    gremlin.render(frameDelta);
    confetti.update(frameDelta);
    hud.update(fuse);
    whine.update(
      drone.object.position,
      view.camera,
      drone.throttleLevel,
      fuse.telegraphProgress,
      !fuse.piloted && fuse.state !== 'returning',
    );

    const showFpv = pilot === 'drone' && fpvMode && !orbitMode;
    fpv.update(frameDelta, drone.velocity, drone.yawRate, drone.throttleLevel, fuse.telegraphProgress, showFpv);
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
      `sim clock    ${(physics.totalSteps * FIXED_TIMESTEP).toFixed(2)}s  (${physics.totalSteps} steps)`,
      `fuse         ${fuse.state}  cycle ${fuse.cycle + 1}  charge ${(fuse.charge * 100).toFixed(1)}%` +
        `  ${fuse.secondsRemaining.toFixed(1)}s left`,
      `runner       ${runner.alive ? 'alive' : 'ELIMINATED'}${runner.carrying ? ' CARRYING' : ''}` +
        `   audio ${whine.running ? 'on' : 'off (click)'}`,
      `objective    cores ${objective.status().inserted}/${objective.status().required}` +
        `  charge ${(objective.charge * 100).toFixed(1)}%` +
        `  in zone ${objective.status().present}/${objective.status().needed}` +
        `${objective.fired ? '  EMP FIRED — RUNNERS WIN' : ''}`,
      `gremlin      ${gremlin.status().active ? `flying · triggers ${gremlin.status().actionsLeft}` : 'inactive'}` +
        `${gremlin.status().blocked ? ` (${gremlin.status().blocked})` : ''}`,
      `hazards      swat ${hazards.status().swatCooldown.toFixed(1)}s` +
        `  prop ${hazards.status().holdingProp ? 'held' : '-'}` +
        `  net ${hazards.status().netSlow > 0 ? 'TANGLED' : '-'}` +
        `  knocked ${drone.knocked ? 'YES' : 'no'}` +
        `  sabotaged [${hazards.disabledPadIndices().join(',')}]`,
      `pads free    ${objective.availablePads().length}/3   camera ${fpvMode && pilot === 'drone' ? 'FPV' : 'chase'}`,
      ...runner.debugLines(),
      ...drone.debugLines(),
      `cube y       ${testCube.height.toFixed(2)}  ${testCube.isAsleep ? '(asleep)' : '(awake)'}`,
      `camera       boom ${camera.boomLength.toFixed(2)} / ${CAMERA_DISTANCE.toFixed(1)} m`,
      `draw calls   ${view.renderer.info.render.calls}   tris ${view.renderer.info.render.triangles}`,
      '',
      'E interact · F swat · Q grab/throw · G gremlin · C swap · V FPV · R respawn · O free cam',
    ]);
    overlay.update(frameDelta, physics);

    // Server-authoritative state, rendered verbatim and never recomputed.
    const snapshot = net.snapshot();
    if (snapshot) {
      lobby.update(snapshot, net.sessionId);
      avatars.update(snapshot, net.sessionId, frameDelta);
      fuse.charge = snapshot.battery;
      fuse.cycle = snapshot.cycle;
      fuse.state = snapshot.fuseState as typeof fuse.state;
    } else if (net.error) {
      avatars.clear();
    }
    net.update(
      frameDelta,
      pilot === 'drone'
        ? { x: drone.position.x, y: drone.position.y, z: drone.position.z, yaw: drone.yaw }
        : { x: runner.position.x, y: runner.position.y, z: runner.position.z, yaw: camera.heading },
      interactHeld,
    );

    if (empFlash > 0) empFlash = Math.max(0, empFlash - frameDelta);
    hud.updateObjective(objective.status(), empFlash / EMP_FLASH_TIME);
    sfx.setEmpCharge(objective.fired ? 0 : objective.charge);
    // Core count changing is the cue for the insert clunk.
    if (objective.status().inserted !== lastInserted) {
      lastInserted = objective.status().inserted;
      sfx.click(CLICK_PITCH_INSERT);
    }
    if (runner.carrying !== lastCarrying) {
      lastCarrying = runner.carrying;
      if (lastCarrying) sfx.click(CLICK_PITCH_PICKUP);
    }

    input.endFrame();
    if (fpv.visible) fpv.render(view.scene);
    else view.render();
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
