/**
 * Physics integrity: 120 consecutive rounds plus body/collider checks.
 * SUCCESS/FAIL stay under existing game logic; physics only integrates motion.
 */
import { writeFileSync } from 'node:fs';
import { gameConfig } from '../js/config/gameConfig.js';
import { EventBus } from '../js/utils/EventBus.js';
import { SettingsManager } from '../js/core/SettingsManager.js';
import { RandomResultGenerator } from '../js/core/RandomResultGenerator.js';
import { RoundManager } from '../js/core/RoundManager.js';
import { GameManager, GameState } from '../js/core/GameManager.js';
import { Aircraft } from '../js/flight/Aircraft.js';
import { Ship } from '../js/flight/Ship.js';
import { FlightController } from '../js/flight/FlightController.js';
import { MultiplierSystem } from '../js/flight/MultiplierSystem.js';
import { LandingSequence } from '../js/flight/LandingSequence.js';
import { AircraftPhysicsController } from '../js/flight/AircraftPhysicsController.js';
import { Wallet } from '../js/economy/Wallet.js';
import { BetManager } from '../js/economy/BetManager.js';
import { GameHistory } from '../js/history/GameHistory.js';
import { clampImpulse, sanitizeVelocity } from '../js/physics/Body.js';

const ROUND_COUNT = 120;
const failures = [];

function fail(name, detail) {
  failures.push({ name, detail: String(detail) });
}

function ok(cond, name, detail) {
  if (!cond) fail(name, detail ?? 'failed');
}

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function installClock() {
  let now = 0;
  let rafId = 1;
  let timeoutId = 1;
  const rafQueue = [];
  const timeouts = [];

  globalThis.window = globalThis;
  globalThis.localStorage = memoryStorage();
  globalThis.performance = { now: () => now };
  globalThis.requestAnimationFrame = (cb) => {
    const id = rafId++;
    rafQueue.push({ id, cb });
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    const i = rafQueue.findIndex((item) => item.id === id);
    if (i >= 0) rafQueue.splice(i, 1);
  };
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = timeoutId++;
    timeouts.push({ id, fn, due: now + ms });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    const i = timeouts.findIndex((item) => item.id === id);
    if (i >= 0) timeouts.splice(i, 1);
  };

  function flushTimeouts() {
    timeouts.sort((a, b) => a.due - b.due);
    const ready = timeouts.filter((item) => item.due <= now);
    for (const item of ready) {
      const i = timeouts.indexOf(item);
      if (i >= 0) timeouts.splice(i, 1);
      item.fn();
    }
  }

  async function tick() {
    flushTimeouts();
    if (rafQueue.length) {
      const batch = rafQueue.splice(0, rafQueue.length);
      now += 16;
      for (const item of batch) item.cb(now);
      flushTimeouts();
      await Promise.resolve();
      return;
    }
    if (timeouts.length) {
      now = Math.max(now, timeouts[0].due);
      flushTimeouts();
      await Promise.resolve();
      return;
    }
    await Promise.resolve();
  }

  async function pumpUntil(isDone, maxFrames = 1200) {
    for (let i = 0; i < maxFrames; i += 1) {
      await tick();
      if (isDone() && !rafQueue.length && !timeouts.length) return i;
      if (!isDone() && !rafQueue.length && !timeouts.length) {
        await Promise.resolve();
        flushTimeouts();
        if (!isDone() && !rafQueue.length && !timeouts.length) {
          throw new Error(`event loop starved; frame=${i}`);
        }
      }
    }
    throw new Error(`hung after ${maxFrames} frames; done=${isDone()}`);
  }

  return { pumpUntil, pending: () => ({ raf: rafQueue.length, timeouts: timeouts.length }) };
}

function createGame() {
  const config = {
    ...gameConfig,
    startingBalance: 1_000_000,
    landingResultDelayMs: 0,
    roundResetDelayMs: 0,
    storageKey: `phys-${Math.random().toString(16).slice(2)}`,
  };
  const storage = memoryStorage();
  const bus = new EventBus();
  const settings = new SettingsManager(config, storage);
  settings.set('playbackSpeed', 1);
  const aircraft = new Aircraft();
  const ship = new Ship(config.flight.world, config.roundResult.landingZone);
  const game = new GameManager({
    wallet: new Wallet(config, storage),
    betManager: new BetManager(config, settings),
    roundManager: new RoundManager(),
    randomResultGenerator: new RandomResultGenerator(config),
    flightController: new FlightController(config, aircraft, ship),
    landingSequence: new LandingSequence(config, aircraft, ship),
    multiplierSystem: new MultiplierSystem(config),
    animationController: { reset() {}, show() {}, render() {}, prepareRound() {}, returnToIdle() {} },
    audioManager: {
      playEngine() {},
      stopEngine() {},
      setEngineFromSpeed() {},
      playLanding() {},
      playCrash() {},
      playSuccess() {},
      playFail() {},
      unlock() {},
    },
    history: new GameHistory(config, storage),
    settings,
    bus,
    config,
  });
  return { game, config, ship, aircraft };
}

async function runRound(game, pumpUntil) {
  const ticks = [];
  const results = [];
  const numberIds = new Set();
  const rocketIds = new Set();
  let duplicateHits = 0;
  let created = 0;

  const off = [
    game.bus.on('round:created', () => {
      created += 1;
    }),
    game.bus.on('round:success', (record) => results.push({ type: 'SUCCESS', record })),
    game.bus.on('round:fail', (record) => results.push({ type: 'FAIL', record })),
    game.bus.on('flight:tick', (pose) => ticks.push(pose)),
    game.bus.on('multiplier:hit', (payload) => {
      const id = payload?.id;
      if (!id) return;
      if (numberIds.has(id)) duplicateHits += 1;
      numberIds.add(id);
    }),
    game.bus.on('rocket:hit', (payload) => {
      const id = payload?.rocket?.id;
      if (!id) return;
      if (rocketIds.has(id)) duplicateHits += 1;
      rocketIds.add(id);
    }),
  ];

  const pending = Promise.resolve(game.startRound());
  let settled = false;
  pending.finally(() => {
    settled = true;
  });
  await pumpUntil(() => settled);
  await pending;
  for (const unsub of off) unsub();
  return {
    ticks,
    results,
    duplicateHits,
    created,
    endState: game.state,
    physics: game.physics,
  };
}

function testUnitPhysics(config) {
  const cleaned = sanitizeVelocity(Number.NaN, Number.NEGATIVE_INFINITY, 80);
  ok(cleaned.vx === 0 && cleaned.vy === 0, 'NaN velocity sanitized');
  ok(Math.abs(clampImpulse(999, 999, 90).x) <= 90, 'impulse magnitude capped');

  const aircraft = new Aircraft();
  const physics = new AircraftPhysicsController(config, aircraft);
  ok(aircraft.body.kinematic === false, 'aircraft body is dynamic');
  ok(aircraft.collider.kind === 'aircraft', 'aircraft collider kind');

  physics.reset({ distance: 120, altitude: 100, pitch: -5 });
  physics.body.vx = 200;
  const heading = physics.body.rotation;
  physics.applyNumberHit();
  ok(physics.body.rotation === heading, 'digit collision does not yank heading');
  ok(physics.body.vx === 200, 'digit collision keeps forward speed');

  physics.applyRocketHit({ damage: { altitude: 14, speed: 0.25 } });
  ok(physics.body.vy < 0, 'rocket adds downward velocity');
  ok(physics.body.vx < 200, 'rocket cuts speed');

  const rates = [30, 60, 120];
  const ends = [];
  for (const fps of rates) {
    const plane = new Aircraft();
    const body = new AircraftPhysicsController(config, plane);
    body.reset({ distance: 48, altitude: 26, pitch: 0 });
    const dt = 1 / fps;
    let t = 0;
    while (t < 2) {
      body.follow({ distance: 48 + t * 220, altitude: 26 + 80 * Math.sin(t), pitch: -6 }, dt, 'flight');
      t += dt;
      ok(Number.isFinite(body.body.vx) && Number.isFinite(body.body.x), `${fps}fps finite`);
    }
    ends.push({ fps, x: body.body.x, y: body.body.y, speed: Math.hypot(body.body.vx, body.body.vy) });
  }
  ok(Math.abs(ends[0].x - ends[1].x) < 90, '30fps and 60fps stay close', `${ends[0].x} vs ${ends[1].x}`);
  ok(Math.abs(ends[1].x - ends[2].x) < 70, '60fps and 120fps stay close', `${ends[1].x} vs ${ends[2].x}`);
}

async function main() {
  const clock = installClock();
  testUnitPhysics(gameConfig);

  const { game, ship } = createGame();
  ok(ship.zoneCollider.kind === 'landing-zone', 'landing zone collider present');
  ok(game.physics instanceof AircraftPhysicsController, 'GameManager owns AircraftPhysicsController');
  game.setBet(20);

  const stats = { total: 0, success: 0, fail: 0, hung: 0 };

  for (let i = 0; i < ROUND_COUNT; i += 1) {
    try {
      const sample = await runRound(game, (done) => clock.pumpUntil(done, 1400));
      const tag = `phys round ${i + 1}`;
      ok(sample.created === 1, `${tag} created once`);
      ok(sample.results.length === 1, `${tag} one result`);
      ok(sample.duplicateHits === 0, `${tag} collisions once`, sample.duplicateHits);
      ok(sample.endState === GameState.IDLE, `${tag} back to IDLE`);
      const type = sample.results[0]?.type;
      ok(type === 'SUCCESS' || type === 'FAIL', `${tag} binary result`);
      if (type === 'SUCCESS') {
        ok(sample.ticks.some((tick) => tick.phase === 'LANDING' || tick.landed), `${tag} landing visualized`);
        ok(!sample.ticks.some((tick) => tick.phase === 'CRASH' && tick.landingStage === 'IMPACT'), `${tag} SUCCESS not crashed by physics`);
        stats.success += 1;
      } else {
        ok(sample.ticks.some((tick) => tick.phase === 'CRASH'), `${tag} crash visualized`);
        stats.fail += 1;
      }
      for (const tick of sample.ticks) {
        ok(Number.isFinite(tick.distance) && Number.isFinite(tick.altitude) && Number.isFinite(tick.speed), `${tag} pose finite`);
        ok(tick.speed >= 0 && tick.speed !== Infinity && tick.speed <= 500, `${tag} speed bounded`);
        ok(tick.distance >= -1 && tick.distance <= 2500, `${tag} in world X`);
        ok(tick.altitude >= -20 && tick.altitude <= 400, `${tag} in world Y`);
        ok(Number.isFinite(tick.vx) && Number.isFinite(tick.vy), `${tag} velocity finite`);
      }
      const body = sample.physics.body;
      ok(Number.isFinite(body.vx) && Number.isFinite(body.vy), `${tag} body velocity finite`);
      stats.total += 1;
    } catch (error) {
      stats.hung += 1;
      fail(`phys round ${i + 1} hung`, error);
      break;
    }
  }

  const pending = clock.pending();
  ok(pending.raf === 0 && pending.timeouts === 0, 'no leftover timers');
  ok(stats.hung === 0, 'no hangs', stats.hung);
  ok(stats.total === ROUND_COUNT, 'completed 120 physics rounds', stats.total);

  const report = {
    passed: failures.length === 0,
    failureCount: failures.length,
    failures: failures.slice(0, 40),
    rounds: stats,
  };
  writeFileSync(`${process.cwd()}\\tests\\physics-invariants-report.json`, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(
    `${process.cwd()}\\tests\\physics-invariants-summary.txt`,
    [
      report.passed ? 'PASSED' : `FAILED (${failures.length})`,
      `rounds ${stats.total} success=${stats.success} fail=${stats.fail} hung=${stats.hung}`,
      ...failures.slice(0, 20).map((item) => `- ${item.name}: ${item.detail}`),
    ].join('\n'),
    'utf8',
  );
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
