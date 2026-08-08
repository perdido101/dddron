import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import {
  ARENA_SIZE,
  CAMERA_DISTANCE,
  CAMERA_TARGET_HEIGHT,
  DRONE_CAMERA_DISTANCE,
  DRONE_CAMERA_HEIGHT,
  DRONE_CAMERA_LAG,
  FOOT_OFFSET,
} from '@shared/constants';

import { DebugOverlay } from './engine/debugOverlay';
import { Input } from './engine/input';
import { Physics } from './engine/physics';
import { View } from './engine/view';
import { Arena } from './game/arena';
import { Drone } from './game/drone';
import { FollowCamera } from './game/followCamera';
import { Runner } from './game/runner';
import { TestCube } from './game/testCube';

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

  function setHint(): void {
    if (!hintElement) return;
    hintElement.textContent = orbitMode
      ? 'FREE CAM — drag to look · O to return'
      : HINTS[pilot];
  }
  setHint();

  physics.onFixedStep((dt) => {
    // Both bodies always simulate; only the piloted one receives input. That is
    // what lets you park the drone, swap to the runner, and walk into its wash.
    runner.fixedUpdate(dt, moveInput, camera.heading);
    drone.fixedUpdate(dt, droneInput, washTargets);
  });
  physics.onFixedPostStep(() => {
    drone.sample();
    testCube.sample();
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
    const frameDelta = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

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
    if (input.consumePress(KEY_RESPAWN)) runner.respawn();
    if (input.consumePress(KEY_DROP_CUBE)) testCube.drop();

    moveInput.set(0, 0);
    droneInput.move.set(0, 0);
    droneInput.lift = 0;

    if (!orbitMode) {
      const strafe = (input.isHeld(KEY_RIGHT) ? 1 : 0) - (input.isHeld(KEY_LEFT) ? 1 : 0);
      const forward = (input.isHeld(KEY_FORWARD) ? 1 : 0) - (input.isHeld(KEY_BACK) ? 1 : 0);

      if (pilot === 'runner') {
        moveInput.set(strafe, forward);
        if (input.pointerLocked) camera.look(input.mouseDeltaX, input.mouseDeltaY);
        if (input.consumePress(KEY_JUMP)) runner.queueJump();
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
    drone.render(physics.alpha, frameDelta);
    testCube.render(physics.alpha);

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

    overlay.setExtraLines([
      `piloting     ${orbitMode ? 'free cam (debug)' : pilot}`,
      ...runner.debugLines(),
      ...drone.debugLines(),
      `cube y       ${testCube.height.toFixed(2)}  ${testCube.isAsleep ? '(asleep)' : '(awake)'}`,
      `camera       boom ${camera.boomLength.toFixed(2)} / ${CAMERA_DISTANCE.toFixed(1)} m`,
      `draw calls   ${view.renderer.info.render.calls}   tris ${view.renderer.info.render.triangles}`,
      '',
      'C swap pilot · R respawn runner · B drop cube · O free cam · ~ overlay',
    ]);
    overlay.update(frameDelta, physics);

    input.endFrame();
    view.render();
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
