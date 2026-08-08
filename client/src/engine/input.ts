/**
 * Keyboard, mouse-look and pointer lock.
 *
 * Movement keys are sampled (held state) while one-shot keys are edge-latched,
 * so a press that happens between two fixed steps is never swallowed.
 */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();

  /** Accumulated mouse delta since the last read, in raw pixels. */
  mouseDeltaX = 0;
  mouseDeltaY = 0;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      this.held.add(event.code);
      this.pressed.add(event.code);
    });
    window.addEventListener('keyup', (event) => this.held.delete(event.code));
    // A tab-away must not leave keys stuck down.
    window.addEventListener('blur', () => this.held.clear());

    target.addEventListener('click', () => {
      if (document.pointerLockElement !== target) void target.requestPointerLock();
    });
    document.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement !== target) return;
      this.mouseDeltaX += event.movementX;
      this.mouseDeltaY += event.movementY;
    });
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.target;
  }

  isHeld(code: string): boolean {
    return this.held.has(code);
  }

  /** True once per physical press. */
  consumePress(code: string): boolean {
    return this.pressed.delete(code);
  }

  /** Drop any presses not consumed this frame, so they cannot fire late. */
  endFrame(): void {
    this.pressed.clear();
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }
}
