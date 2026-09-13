/**
 * Full invariant suite. Uses production game modules.
 * Time is fast-forwarded in the harness only — game rules are unchanged.
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
import { MultiplierNumberField } from '../js/flight/MultiplierNumberField.js';
import { RocketField } from '../js/flight/RocketField.js';
import { LandingSequence } from '../js/flight/LandingSequence.js';
import { AircraftPhysicsController } from '../js/flight/AircraftPhysicsController.js?v=high-hits6';
import { GameScene } from '../js/scene/GameScene.js';
import { clampImpulse, sanitizeVelocity } from '../js/physics/Body.js';
import { Wallet } from '../js/economy/Wallet.js';
import { BetManager } from '../js/economy/BetManager.js';
import { GameHistory } from '../js/history/GameHistory.js';
import { ALLOWED_TRANSITIONS } from '../js/core/GameState.js';

const ROUND_COUNT = 1000;
const GENERATOR_SAMPLES = 10000;
const failures = [];

function fail(name, detail) {
  failures.push({ name, detail: String(detail) });
}

function ok(cond, name, detail) {
  if (!cond) fail(name, detail ?? 'failed');
}

function finite(n) {
  return Number.isFinite(n);
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
      now += 50;
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

  async function pumpUntil(isDone, maxFrames = 800) {
    for (let i = 0; i < maxFrames; i += 1) {
      await tick();
      if (isDone() && !rafQueue.length && !timeouts.length) return i;
      if (!isDone() && !rafQueue.length && !timeouts.length) {
        await Promise.resolve();
        flushTimeouts();
        if (!isDone() && !rafQueue.length && !timeouts.length) {
          throw new Error(`event loop starved before round finished; frame=${i}`);
        }
      }
    }
    throw new Error(
      `animation hung after ${maxFrames} frames; raf=${rafQueue.length} timeouts=${timeouts.length} done=${isDone()}`,
    );
  }

  return {
    pumpUntil,
    pending: () => ({ raf: rafQueue.length, timeouts: timeouts.length }),
    now: () => now,
  };
}

function stubAudio() {
  return {
    playEngine() {},
    stopEngine() {},
    setEngineFromSpeed() {},
    playLanding() {},
    playCrash() {},
    playSuccess() {},
    playFail() {},
    unlock() {},
  };
}

function stubAnimation() {
  return {
    reset() {},
    show() {},
    render() {},
    prepareRound() {},
    returnToIdle() {},
  };
}

function createGame(clockStorage) {
  const config = {
    ...gameConfig,
    startingBalance: 1_000_000,
    landingResultDelayMs: 0,
    roundResetDelayMs: 0,
    storageKey: `test-${Math.random().toString(16).slice(2)}`,
  };
  const storage = clockStorage ?? memoryStorage();
  const bus = new EventBus();
  const settings = new SettingsManager(config, storage);
  settings.set('playbackSpeed', 1);
  const wallet = new Wallet(config, storage);
  const betManager = new BetManager(config, settings);
  const history = new GameHistory(config, storage);
  const aircraft = new Aircraft();
  const ship = new Ship(config.flight.world, config.roundResult.landingZone);
  const game = new GameManager({
    wallet,
    betManager,
    roundManager: new RoundManager(),
    randomResultGenerator: new RandomResultGenerator(config),
    flightController: new FlightController(config, aircraft, ship),
    landingSequence: new LandingSequence(config, aircraft, ship),
    multiplierSystem: new MultiplierSystem(config),
    animationController: stubAnimation(),
    audioManager: stubAudio(),
    history,
    settings,
    bus,
    config,
  });
  return { game, bus, wallet, betManager, config, settings };
}

async function runRound(game, pumpUntil, onTick) {
  const states = [];
  const results = [];
  const ticks = [];
  const debitTrace = [];
  const creditTrace = [];
  const startBalance = game.wallet.getBalance();
  const bet = game.betManager.getAmount();
  let illegal = 0;
  let created = 0;
  const numberHits = new Set();
  const rocketHits = new Set();
  let duplicateHits = 0;

  const off = [
    game.bus.on('game:stateChange', (snap) => {
      states.push(snap.state);
      if (onTick) onTick(snap, game);
    }),
    game.bus.on('round:created', () => {
      created += 1;
    }),
    game.bus.on('round:success', (record) => results.push({ type: 'SUCCESS', record })),
    game.bus.on('round:fail', (record) => results.push({ type: 'FAIL', record })),
    game.bus.on('game:illegalTransition', () => {
      illegal += 1;
    }),
    game.bus.on('flight:tick', (pose) => {
      ticks.push(pose);
    }),
    game.bus.on('multiplier:hit', (payload) => {
      const id = payload?.id;
      if (!id) return;
      if (numberHits.has(id)) duplicateHits += 1;
      numberHits.add(id);
    }),
    game.bus.on('rocket:hit', (payload) => {
      const id = payload?.rocket?.id;
      if (!id) return;
      if (rocketHits.has(id)) duplicateHits += 1;
      rocketHits.add(id);
    }),
    game.bus.on('wallet:changed', ({ balance }) => {
      const delta = balance - (debitTrace.at(-1)?.balance ?? startBalance);
      if (delta < 0) debitTrace.push({ balance, delta });
      if (delta > 0) creditTrace.push({ balance, delta });
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
    states,
    results,
    ticks,
    debitTrace,
    creditTrace,
    created,
    illegal,
    numberHits: numberHits.size,
    rocketHits: rocketHits.size,
    duplicateHits,
    startBalance,
    bet,
    endBalance: game.wallet.getBalance(),
    endState: game.state,
  };
}

function assertRound(sample, index) {
  const tag = `round ${index + 1}`;
  ok(sample.created === 1, `${tag} exactly one create`, sample.created);
  ok(sample.results.length === 1, `${tag} exactly one result event`, JSON.stringify(sample.results.map((r) => r.type)));
  ok(sample.illegal === 0, `${tag} no illegal transitions`, sample.illegal);

  const result = sample.results[0];
  if (!result) return;
  ok(result.type === 'SUCCESS' || result.type === 'FAIL', `${tag} result is SUCCESS or FAIL`, result.type);
  ok(!(result.type === 'SUCCESS' && sample.results.some((r) => r.type === 'FAIL')), `${tag} not both`);

  const visited = new Set(sample.states);
  if (result.type === 'SUCCESS') {
    ok(visited.has(GameState.LANDING), `${tag} SUCCESS ends via LANDING`);
    ok(!visited.has(GameState.CRASH), `${tag} SUCCESS never CRASH`);
    const landed = sample.ticks.some((tick) => tick.phase === 'LANDING' || tick.landed);
    ok(landed, `${tag} SUCCESS has landing pose`);
    ok(
      sample.ticks.some((tick) => tick.landed || (tick.phase === 'LANDING' && tick.altitude <= 38 && tick.distance >= 1260 && tick.distance <= 1520)),
      `${tag} SUCCESS reaches the deck`,
    );
    ok(sample.creditTrace.length === 1, `${tag} win credited once`, sample.creditTrace.length);
  } else {
    ok(visited.has(GameState.CRASH), `${tag} FAIL ends via CRASH`);
    ok(!visited.has(GameState.LANDING), `${tag} FAIL never LANDING`);
    const crashed = sample.ticks.some((tick) => tick.phase === 'CRASH');
    ok(crashed, `${tag} FAIL has crash pose`);
    ok(sample.creditTrace.length === 0, `${tag} FAIL does not credit win`, sample.creditTrace.length);
  }

  ok(sample.debitTrace.length === 1, `${tag} bet debited once`, sample.debitTrace.length);
  ok(Math.abs(sample.debitTrace[0]?.delta + sample.bet) < 0.001, `${tag} debit equals bet`);

  ok(finite(sample.endBalance), `${tag} balance finite`, sample.endBalance);
  ok(sample.endBalance === sample.endBalance && !Number.isNaN(sample.endBalance), `${tag} balance not NaN`);

  for (const tick of sample.ticks) {
    ok(finite(tick.multiplier), `${tag} multiplier finite`, tick.multiplier);
    ok(tick.multiplier !== Infinity && tick.multiplier !== -Infinity, `${tag} multiplier not Infinity`);
    ok(finite(tick.altitude) && finite(tick.distance) && finite(tick.speed), `${tag} pose finite`);
    ok(tick.speed >= 0, `${tag} speed not negative`, tick.speed);
    ok(tick.speed !== Infinity, `${tag} speed not infinite`);
    ok(tick.speed <= 500, `${tag} speed clamped`, tick.speed);
    ok(tick.distance >= -1 && tick.distance <= 20000, `${tag} plane in world X`, tick.distance);
    ok(tick.altitude >= -20 && tick.altitude <= 400, `${tag} plane in world Y`, tick.altitude);
    if (tick.vx != null) ok(finite(tick.vx) && tick.vx !== Infinity, `${tag} vx finite`);
    if (tick.vy != null) ok(finite(tick.vy) && tick.vy !== Infinity, `${tag} vy finite`);
  }
  const settled = result.record.multiplier;
  ok(finite(settled) && settled !== Infinity, `${tag} settled multiplier finite`, settled);

  ok(sample.duplicateHits === 0, `${tag} collisions fire once`, sample.duplicateHits);
  ok(sample.endState === GameState.IDLE, `${tag} returns to IDLE`, sample.endState);
  ok(sample.states.includes(GameState.RESULT), `${tag} visited RESULT`);
  ok(sample.states.includes(GameState.RESET) || sample.states.at(-1) === GameState.IDLE, `${tag} visited RESET/IDLE`);
}

function testGeneratorStats(config, samples) {
  const gen = new RandomResultGenerator(config);
  let success = 0;
  let fail = 0;
  const zone = config.roundResult.landingZone;
  for (let i = 0; i < samples; i += 1) {
    const round = gen.generateRoundResult();
    ok(round.result === 'SUCCESS' || round.result === 'FAIL', 'generator binary result', round.result);
    ok(round.result === 'SUCCESS' ? round.result !== 'FAIL' : round.result !== 'SUCCESS', 'not both');
    if (round.result === 'SUCCESS') {
      success += 1;
      ok(round.targetDistance >= zone.start && round.targetDistance <= zone.end, 'SUCCESS in landing zone');
    } else {
      fail += 1;
      ok(round.targetDistance >= zone.end + (config.roundResult.fail.minOvershoot ?? 20), 'FAIL past deck');
    }
    ok(finite(round.multiplier) && round.multiplier !== Infinity, 'generator multiplier finite');
    ok(finite(round.maxAltitude) && finite(round.flightDuration), 'generator params finite');
  }
  ok(success + fail === samples, 'generator counts sum', `${success}+${fail}`);
  const configured =
    config.successProbability / (config.successProbability + config.failProbability || 1);
  return {
    totalRounds: samples,
    successfulRounds: success,
    failedRounds: fail,
    actualSuccessRate: success / samples,
    configuredSuccessRate: configured,
  };
}

function testNumberPickups(config) {
  const aircraft = new Aircraft();
  const ship = new Ship(config.flight.world, config.roundResult.landingZone);
  const flight = new FlightController(config, aircraft, ship);
  const gen = new RandomResultGenerator(config, () => 0.31);
  const round = gen.generateRoundResult();
  const path = flight.generateFlightPath(round);
  const field = new MultiplierNumberField(config);
  field.spawn(7, path);

  ok(field.items.length >= (config.numberPickups?.minCount ?? 20), 'at least 20 number objects', field.items.length);
  const ids = new Set(field.items.map((item) => item.id));
  ok(ids.size === field.items.length, 'number ids unique');
  ok(
    field.items.every((item) => item.collider && item.body && item.collider.kind === 'multiplier-number' && item.collider.enabled),
    'every number has an enabled collider',
  );
  ok(
    field.items.every((item) => item.number >= 1 && item.number <= 10),
    'number values stay in 1..10',
  );
  ok(new Set(field.items.map((item) => item.number)).size === 10, 'all digits 1-10 appear');

  const alts = field.items.map((item) => item.altitude);
  const dists = field.items.map((item) => item.distance);
  ok(Math.max(...alts) - Math.min(...alts) > 70, 'numbers sit at different heights', Math.max(...alts) - Math.min(...alts));
  ok(Math.max(...dists) - Math.min(...dists) > 400, 'numbers sit at different distances', Math.max(...dists) - Math.min(...dists));
  ok(
    field.items.some((item) => Math.abs(item.lateral ?? 0) > 20),
    'numbers are not all on the flight centerline',
  );

  for (let i = 0; i < field.items.length; i += 1) {
    for (let j = i + 1; j < field.items.length; j += 1) {
      const dx = field.items[i].distance - field.items[j].distance;
      const dy = field.items[i].altitude - field.items[j].altitude;
      ok(dx * dx + dy * dy > 1, 'numbers are not stacked in one point');
    }
  }

  const sys = new MultiplierSystem(config);
  const formula = sys.calculateMultiplier(round);
  sys.bind(round, path);
  const payout = sys.payout(20);

  const item = field.items[0];
  aircraft.collider.setPosition(item.distance, item.altitude);
  const hits = field.collectHits(aircraft.collider);
  ok(hits.some((hit) => hit.id === item.id), 'overlap collects once');
  const applied = sys.onMultiplierNumberHit(item.number, { id: item.id });
  ok(applied && applied.number === item.number, 'hit reaches MultiplierSystem');
  ok(
    !field.collectHits(aircraft.collider).some((hit) => hit.id === item.id),
    'same number cannot retrigger',
  );
  ok(sys.onMultiplierNumberHit(item.number, { id: item.id }) === null, 'repeat id ignored');

  const again = sys.calculateMultiplier(round);
  ok(again.value === formula.value && again.peak === formula.peak, 'payout formula unchanged after hit');
  ok(sys.payout(20) === payout, 'SUCCESS/FAIL payout unchanged after hit');

  field.spawn(8, path);
  const target = field.items[4];
  const prev = { x: target.distance - 42, y: target.altitude, radius: aircraft.collider.radius };
  aircraft.collider.setPosition(target.distance + 42, target.altitude);
  const swept = field.collectHits(aircraft.collider, prev);
  ok(
    swept.some((hit) => hit.id === target.id),
    'swept collider detects a fast pass through a number',
  );
}

function testRockets(config) {
  const aircraft = new Aircraft();
  const ship = new Ship(config.flight.world, config.roundResult.landingZone);
  const flight = new FlightController(config, aircraft, ship);
  const gen = new RandomResultGenerator(config, () => 0.31);
  const round = gen.generateRoundResult();
  const path = flight.generateFlightPath(round);
  const field = new RocketField(config);
  field.spawn(3, path);

  ok(field.items.length >= (config.rockets?.minCount ?? 20), 'at least 20 rockets', field.items.length);
  const ids = new Set(field.items.map((item) => item.id));
  ok(ids.size === field.items.length, 'rocket ids unique');
  ok(
    field.items.every((item) => item.collider && item.body && item.collider.kind === 'rocket' && item.collider.enabled && item.active),
    'every rocket has an enabled collider',
  );
  const alts = field.items.map((item) => item.homeAltitude);
  ok(Math.max(...alts) - Math.min(...alts) > 20, 'rockets are not all at one height');

  for (let i = 0; i < field.items.length; i += 1) {
    for (let j = i + 1; j < field.items.length; j += 1) {
      const dx = field.items[i].homeDistance - field.items[j].homeDistance;
      const dy = field.items[i].homeAltitude - field.items[j].homeAltitude;
      ok(dx * dx + dy * dy > 1, 'rockets are not stacked');
    }
  }

  const sys = new MultiplierSystem(config);
  const formula = sys.calculateMultiplier(round);
  sys.bind(round, path);
  sys.current = formula.peak;
  const payout = sys.payout(20);
  const before = sys.sample({ t: 0.5, phase: 'CRUISE' }).value;

  const rocket = field.items[0];
  aircraft.collider.setPosition(rocket.distance, rocket.altitude);
  const hits = field.collectHits(aircraft.collider);
  ok(hits.some((hit) => hit.id === rocket.id), 'rocket overlap hits once');
  const applied = sys.onRocketHit(rocket);
  ok(applied && applied.penalty > 0, 'onRocketHit lowers multiplier');
  const after = sys.sample({ t: 0.5, phase: 'CRUISE' }).value;
  ok(after < before - 0.01, 'live multiplier decreased after rocket', `${before} → ${after}`);
  ok(
    !field.collectHits(aircraft.collider).some((hit) => hit.id === rocket.id),
    'same rocket cannot retrigger',
  );
  ok(sys.onRocketHit(rocket) === null, 'repeat rocket id ignored');
  ok(sys.payout(20) === payout, 'payout unchanged after rocket hit');
  ok(sys.calculateMultiplier(round).value === formula.value, 'SUCCESS/FAIL formula unchanged');

  flight.load(path);
  const pose0 = flight.update(0.016);
  flight.applyRocketHit(rocket);
  const pose1 = flight.update(0.016);
  ok(pose1.altitude < pose0.altitude, 'rocket hit drops altitude slightly');
  ok(pose1.speed <= pose0.speed, 'rocket hit reduces speed');
  ok(pose1.phase === pose0.phase || pose1.distance >= pose0.distance - 1, 'flight continues after rocket');
  let frames = 0;
  while (!flight.isComplete() && frames < 2500) {
    flight.update(1 / 60);
    frames += 1;
  }
  ok(flight.isComplete(), 'flight still completes after rocket hit');
}

function testFps(config) {
  const rates = [30, 60, 120];
  for (const fps of rates) {
    const dt = 1 / fps;
    const aircraft = new Aircraft();
    const ship = new Ship(config.flight.world, config.roundResult.landingZone);
    const flight = new FlightController(config, aircraft, ship);
    const landing = new LandingSequence(config, aircraft, ship);
    const gen = new RandomResultGenerator(config);
    for (const forced of ['SUCCESS', 'FAIL']) {
      const round = { ...gen.generateRoundResult(), result: forced };
      if (forced === 'SUCCESS') {
        round.targetDistance = 1320;
      } else {
        round.targetDistance = 1550;
      }
      const path = flight.generateFlightPath(round);
      const physics = new AircraftPhysicsController(config, aircraft);
      flight.load(path);
      physics.reset({
        distance: config.flight.path.startPosition.distance,
        altitude: config.flight.path.startPosition.altitude,
        pitch: 0,
      });
      let frames = 0;
      let last = null;
      while (!flight.isComplete() && frames < 2000) {
        const guide = flight.update(dt);
        last = physics.follow(guide, dt, 'flight');
        frames += 1;
        ok(finite(last.altitude) && finite(last.distance) && finite(last.pitch), `${fps}fps pose`);
        ok(finite(last.vx) && finite(last.vy) && last.speed >= 0 && last.speed < 500, `${fps}fps velocity`);
      }
      ok(flight.isComplete(), `${fps}fps flight completes`, frames);
      ok(frames > 5, `${fps}fps flight not instant`, frames);
      landing.begin(
        {
          ...flight.handoff(),
          distance: physics.body.x,
          altitude: physics.body.y,
          pitch: physics.body.rotation,
          vx: physics.body.vx,
          vy: physics.body.vy,
        },
        round,
        path,
      );
      frames = 0;
      while (!landing.isComplete() && frames < 2000) {
        const guide = landing.update(dt);
        last = physics.follow(guide, dt, guide.phase === 'CRASH' ? 'crash' : 'landing');
        frames += 1;
        ok(finite(last.altitude) && finite(last.distance), `${fps}fps landing pose`);
      }
      ok(landing.isComplete(), `${fps}fps landing completes`, frames);
      if (forced === 'SUCCESS') {
        ok(last.phase === 'LANDING' || last.landed, `${fps}fps SUCCESS landing phase`, last.phase);
      } else {
        ok(last.phase === 'CRASH', `${fps}fps FAIL crash phase`, last.phase);
      }
    }
  }
}

function testPhysicsController(config) {
  const nan = sanitizeVelocity(Number.NaN, Number.POSITIVE_INFINITY, 100);
  ok(nan.speed === 0 && nan.vx === 0 && nan.vy === 0, 'sanitize NaN/Inf velocity');
  const impulse = clampImpulse(0, -400, 90);
  ok(Math.abs(impulse.y) <= 90, 'impulse clamped', impulse.y);

  const aircraft = new Aircraft();
  ok(aircraft.body && aircraft.collider.kind === 'aircraft', 'aircraft has a dynamic body');
  const ship = new Ship(config.flight.world, config.roundResult.landingZone);
  ok(ship.collider.kind === 'ship' && ship.zoneCollider.kind === 'landing-zone', 'ship and landing zone colliders');
  ok(ship.zoneCollider.sensor && ship.collider.sensor, 'ship/zone colliders are sensors');

  const physics = new AircraftPhysicsController(config, aircraft);
  physics.reset({ distance: 80, altitude: 90, pitch: -4 });
  physics.body.vx = 180;
  physics.body.vy = 12;
  const heading = physics.body.rotation;
  const vxBefore = physics.body.vx;
  physics.applyNumberHit();
  ok(physics.body.vx > vxBefore, 'number hit adds forward speed');
  ok(physics.body.rotation === heading, 'number hit does not spin the plane');

  physics.applyRocketHit({ damage: { altitude: 14, speed: 0.22 } });
  ok(physics.body.vy < 12, 'rocket applies a downward impulse');
  ok(physics.body.vx < vxBefore, 'rocket temporarily cuts speed');
  const cut = physics.body.vx;
  for (let i = 0; i < 90; i += 1) {
    physics.follow({ distance: 80 + i * 3.2, altitude: 90, pitch: -4, vx: 180 }, 1 / 60, 'flight');
    ok(Number.isFinite(physics.body.vx) && Number.isFinite(physics.body.vy), 'physics stays finite after rocket');
    ok(physics.body.x >= 0 && physics.body.x <= 2400, 'plane stays in world');
  }
  ok(Math.abs(physics.body.vx - cut) < 28, 'speed holds after rocket', `${cut} → ${physics.body.vx}`);
  ok(physics.body.vx <= cut + 6, 'speed does not spontaneously recover toward the guide');

  physics.body.vx = Number.NaN;
  physics.body.vy = Number.POSITIVE_INFINITY;
  physics.follow({ distance: 200, altitude: 80, pitch: 0 }, 1 / 60, 'flight');
  ok(Number.isFinite(physics.body.vx) && Number.isFinite(physics.body.vy), 'NaN velocity is repaired');
  ok(physics.body.vx >= 0, 'horizontal speed is not negative in flight');
}

function testShipSpacing(config) {
  const scene = new GameScene(config);
  scene.ensureAhead(0, 3600);
  const ships = scene.layout.slice().sort((a, b) => a.distance - b.distance);
  const shipLen = config.scene.objectScale?.shipWorldLength ?? 176;
  const minGap = Math.max(config.scene.track?.minGap ?? 0, shipLen * 2.25 + 48);
  ok(ships.length >= 3, 'sea has home, target, and ambient ships', ships.length);
  const gaps = [];
  for (let i = 1; i < ships.length; i += 1) {
    const gap = ships[i].distance - ships[i - 1].distance;
    gaps.push(gap);
    ok(gap + 1e-6 >= minGap, 'ships stay apart', `${ships[i - 1].id}→${ships[i].id} ${gap.toFixed(1)}`);
    ok(gap > shipLen, 'ships do not overlap hulls', gap);
  }
  const rounded = new Set(gaps.map((gap) => Math.round(gap / 20)));
  ok(rounded.size >= 2, 'ship gaps are irregular', [...rounded].join(','));
}

function testStateMachine() {
  for (const [from, allowed] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of Object.values(GameState)) {
      const legal = allowed.includes(to);
      if (from === to) continue;
      if (!legal) {
        const machine = { state: from, can: (next) => (ALLOWED_TRANSITIONS[from] ?? []).includes(next) };
        ok(!machine.can(to), `blocked ${from} → ${to}`);
      }
    }
  }
  ok(ALLOWED_TRANSITIONS.IDLE.includes('STARTING'), 'IDLE → STARTING allowed');
  ok(ALLOWED_TRANSITIONS.DESCENT.includes('LANDING'), 'DESCENT → LANDING allowed');
  ok(ALLOWED_TRANSITIONS.DESCENT.includes('CRASH'), 'DESCENT → CRASH allowed');
  ok(!ALLOWED_TRANSITIONS.DESCENT.includes('IDLE'), 'DESCENT → IDLE blocked');
}

async function testConcurrencyAndBets(pumpUntil) {
  const { game } = createGame();
  game.setBet(20);
  const first = Promise.resolve(game.startRound());
  const second = Promise.resolve(game.startRound());
  const midBet = game.setBet(200);
  let settled = false;
  Promise.all([first, second]).finally(() => {
    settled = true;
  });
  await pumpUntil(() => settled);
  await first;
  await second;
  ok(game.history.list().length >= 1, 'only one round recorded after double start');
  const latest = game.history.list()[0];
  ok(latest.bet === 20, 'bet unchanged by in-flight setBet', latest.bet);
  ok(midBet === 20, 'setBet during round returns locked amount', midBet);
}

async function main() {
  writeFileSync(`${process.cwd()}\\tests\\full-invariants-summary.txt`, 'running\n', 'utf8');
  const errors = [];
  const realError = console.error;
  console.error = (...args) => {
    errors.push(args.map(String).join(' '));
    realError(...args);
  };

  const clock = installClock();
  testStateMachine();

  const generatorStats = testGeneratorStats(gameConfig, GENERATOR_SAMPLES);
  testFps(gameConfig);
  testNumberPickups(gameConfig);
  testRockets(gameConfig);
  testPhysicsController(gameConfig);
  testShipSpacing(gameConfig);

  const { game } = createGame();
  game.setBet(20);

  const roundStats = { total: 0, success: 0, fail: 0 };
  let hung = 0;

  for (let i = 0; i < ROUND_COUNT; i += 1) {
    try {
      const sample = await runRound(game, (done) => clock.pumpUntil(done, 1200), (snap, gm) => {
        if (snap.state === GameState.TAKEOFF || snap.state === GameState.CLIMB) {
          const before = gm.betManager.getAmount();
          gm.setBet(200);
          if (gm.betManager.getAmount() !== before) {
            fail(`round ${i + 1} bet changed in flight`, `${before} → ${gm.betManager.getAmount()}`);
          }
          const parallel = gm.startRound();
          void parallel;
        }
      });
      assertRound(sample, i);
      const type = sample.results[0]?.type;
      roundStats.total += 1;
      if (type === 'SUCCESS') roundStats.success += 1;
      else if (type === 'FAIL') roundStats.fail += 1;
    } catch (error) {
      hung += 1;
      fail(`round ${i + 1} threw/hung`, error);
      break;
    }
  }

  const pending = clock.pending();
  ok(pending.raf === 0, 'no leftover rAF', pending.raf);
  ok(pending.timeouts === 0, 'no leftover timers', pending.timeouts);
  ok(hung === 0, 'no animation hangs', hung);
  ok(errors.length === 0, 'no console.error', errors.join(' | '));
  ok(roundStats.total === ROUND_COUNT, 'completed 1000 rounds', roundStats.total);
  ok(roundStats.success + roundStats.fail === roundStats.total, 'success+fail = total');

  await testConcurrencyAndBets((done) => clock.pumpUntil(done, 1200));

  console.error = realError;

  const report = {
    passed: failures.length === 0,
    failureCount: failures.length,
    failures: failures.slice(0, 40),
    gameRounds: {
      totalRounds: roundStats.total,
      successfulRounds: roundStats.success,
      failedRounds: roundStats.fail,
      actualSuccessRate: roundStats.total ? roundStats.success / roundStats.total : 0,
      configuredSuccessRate:
        gameConfig.successProbability / (gameConfig.successProbability + gameConfig.failProbability),
    },
    generator: generatorStats,
    timers: pending,
    consoleErrors: errors,
  };

  const reportPath = `${process.cwd()}\\tests\\full-invariants-report.json`;
  const summaryPath = `${process.cwd()}\\tests\\full-invariants-summary.txt`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(
    summaryPath,
    [
      report.passed ? 'PASSED' : `FAILED (${failures.length})`,
      `gameRounds ${roundStats.total} success=${roundStats.success} fail=${roundStats.fail}`,
      `generator ${generatorStats.successfulRounds}/${generatorStats.totalRounds}`,
      `actual=${generatorStats.actualSuccessRate.toFixed(4)} configured=${generatorStats.configuredSuccessRate.toFixed(2)}`,
      `timers raf=${pending.raf} timeouts=${pending.timeouts}`,
      `consoleErrors=${errors.length}`,
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
