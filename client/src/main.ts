import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { ARENA_SIZE, CAMERA_DISTANCE } from '@shared/constants';

import { DebugOverlay } from './engine/debugOverlay';
import { Input } from './engine/input';
import { Physics } from './engine/physics';
import { View } from './engine/view';
import { Arena } from './game/arena';
import { FollowCamera } from './game/followCamera';
import { Runner } from './game/runner';
import { TestCube } from './game/testCube';

const KEY_FORWARD = 'KeyW';
const KEY_BACK = 'KeyS';
const KEY_LEFT = 'KeyA';
const KEY_RIGHT = 'KeyD';
const KEY_JUMP = 'Space';
const KEY_DEBUG = 'Backquote';
const KEY_ORBIT = 'KeyO';
const KEY_RESPAWN = 'KeyR';
const KEY_DROP_CUBE = 'KeyB';

async function boot(): Promise<void> {
  const physics = await Physics.create();
  const view = new View();
  const input = new Input(view.renderer.domElement);

  new Arena(physics, view.scene);
  const runner = new Runner(physics, view.scene);
  const testCube = new TestCube(physics, view.scene);
  const followCamera = new FollowCamera(view.camera, physics);

  // Debug-only free camera. Phase 1 plays on the follow rig; orbit is here to
  // inspect the arena and, from phase 2, the drone's view.
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
  const anchor = new THREE.Vector3();
  let orbitMode = false;

  physics.onFixedStep((dt) => {
    if (orbitMode) return;
    runner.fixedUpdate(dt, moveInput, followCamera.heading);
  });
  physics.onFixedPostStep(() => testCube.sample());

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
    if (input.consumePress(KEY_ORBIT)) {
      orbitMode = !orbitMode;
      orbit.enabled = orbitMode;
      if (orbitMode) {
        document.exitPointerLock();
        orbit.target.copy(runner.object.position);
      }
      if (hintElement) {
        hintElement.textContent = orbitMode
          ? 'ORBIT CAM (debug) — drag to look · O to return to the runner'
          : 'click to look · WASD move · SPACE jump · ~ debug · O orbit cam';
      }
    }
    if (input.consumePress(KEY_RESPAWN)) runner.respawn();
    if (input.consumePress(KEY_DROP_CUBE)) testCube.drop();

    if (orbitMode) {
      moveInput.set(0, 0);
    } else {
      moveInput.set(
        (input.isHeld(KEY_RIGHT) ? 1 : 0) - (input.isHeld(KEY_LEFT) ? 1 : 0),
        (input.isHeld(KEY_FORWARD) ? 1 : 0) - (input.isHeld(KEY_BACK) ? 1 : 0),
      );
      if (input.pointerLocked) followCamera.look(input.mouseDeltaX, input.mouseDeltaY);
      if (input.consumePress(KEY_JUMP)) runner.queueJump();
    }

    physics.advance(frameDelta);

    runner.render(physics.alpha, frameDelta);
    testCube.render(physics.alpha);

    if (orbitMode) {
      orbit.update();
    } else {
      anchor.copy(runner.object.position);
      followCamera.update(frameDelta, anchor, runner.characterCollider);
    }

    overlay.setExtraLines([
      ...runner.debugLines(),
      `cube y       ${testCube.height.toFixed(2)}  ${testCube.isAsleep ? '(asleep)' : '(awake)'}`,
      `camera       ${orbitMode ? 'orbit (debug)' : 'follow'}  boom ${followCamera.boomLength.toFixed(2)} / ${CAMERA_DISTANCE.toFixed(1)} m`,
      `draw calls   ${view.renderer.info.render.calls}   tris ${view.renderer.info.render.triangles}`,
      '',
      'R respawn · B drop cube · O orbit cam · ~ overlay',
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
