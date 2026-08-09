/**
 * CI guard for sacred constraint 1 (handoff 02, session 2).
 *
 * The brief hard-caps the drone's linear damping at 0.8 — above that the drone
 * can park on a target and the game dies. This parses the constant out of the
 * tuning surface and fails the build if it drifts past the cap, so the
 * constraint cannot be broken silently by a tuning commit.
 */
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../shared/constants.ts', import.meta.url), 'utf8');
const match = source.match(/export const DRONE_LINEAR_DAMPING\s*=\s*([0-9.]+)/);

if (!match) {
  console.error('check-constraints: DRONE_LINEAR_DAMPING not found in shared/constants.ts');
  process.exit(1);
}

const damping = Number(match[1]);
const CAP = 0.8;
if (!(damping <= CAP)) {
  console.error(
    `check-constraints: DRONE_LINEAR_DAMPING = ${damping} exceeds the sacred cap of ${CAP} ` +
    '(build brief section 3, constraint 1). Refusing to build.',
  );
  process.exit(1);
}
console.log(`check-constraints: DRONE_LINEAR_DAMPING = ${damping} <= ${CAP} — ok`);
