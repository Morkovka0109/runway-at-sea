import {
  ALLOWED_TRANSITIONS,
  FLIGHT_PHASE_ORDER,
  GameState,
  canChangeBetIn,
  isPreRoundState,
} from './GameState.js';
import { StateMachine } from './StateMachine.js';
import { MultiplierNumberField } from '../flight/MultiplierNumberField.js?v=high-hits6';
import { RocketField } from '../flight/RocketField.js?v=high-hits6';
import { AircraftPhysicsController } from '../flight/AircraftPhysicsController.js?v=high-hits6';

export { GameState };

/**
 * Orchestrates the round loop through an explicit state machine.
 * UI listens to bus events; this class does not touch DOM.
 */
export class GameManager {
  constructor(deps) {
    this.wallet = deps.wallet;
    this.betManager = deps.betManager;
    this.roundManager = deps.roundManager;
    this.randomResultGenerator = deps.randomResultGenerator;
    this.flightController = deps.flightController;
    this.landingSequence = deps.landingSequence;
    this.multiplierSystem = deps.multiplierSystem;
    this.animationController = deps.animationController;
    this.audioManager = deps.audioManager;
    this.history = deps.history;
    this.settings = deps.settings;
    this.bus = deps.bus;
    this.config = deps.config;
    this.numberField = deps.numberField ?? new MultiplierNumberField(this.config);
    this.rocketField = deps.rocketField ?? new RocketField(this.config);
    this.physics =
      deps.physics ??
      new AircraftPhysicsController(this.config, this.flightController.aircraft);
    this.machine = new StateMachine({
      initial: GameState.IDLE,
      transitions: ALLOWED_TRANSITIONS,
    });
    this.running = false;
    this._raf = 0;
    this._startLock = false;
    this._prevPlane = null;
  }

  get state() {
    return this.machine.state;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.animationController.reset();
    this.physics.reset(this._idlePose());
    this.animationController.show(this._idlePose());
    this.animationController.render(0);
    this._loop(performance.now());
    this.bus.emit('game:ready', this.snapshot());
  }

  snapshot() {
    const current = this.roundManager.getCurrent();
    return {
      state: this.state,
      balance: this.wallet.getBalance(),
      bet: this.betManager.getAmount(),
      locked: this.betManager.isLocked() || !this.canChangeBet(),
      soundEnabled: this.settings.soundEnabled,
      playbackSpeed: this.settings.playbackSpeed,
      history: this.history.list(),
      roundNumber: current?.roundNumber ?? this.history.nextNumber(),
      lastResult: current?.result ?? this.history.list()[0]?.result ?? null,
    };
  }

  canChangeBet() {
    return canChangeBetIn(this.state) && !this.betManager.isLocked() && !this._startLock;
  }

  canStartRound() {
    return (
      !this._startLock &&
      isPreRoundState(this.state) &&
      this.machine.can(GameState.STARTING) &&
      !this.betManager.isLocked() &&
      this.wallet.canAfford(this.betManager.getAmount())
    );
  }

  setBet(value) {
    if (!this.canChangeBet()) return this.betManager.getAmount();
    this._enterBetting();
    const amount = this.betManager.setAmount(value, this.wallet.getBalance());
    this.bus.emit('game:stateChange', this.snapshot());
    return amount;
  }

  adjustBet(delta) {
    if (!this.canChangeBet()) return this.betManager.getAmount();
    this._enterBetting();
    const amount = this.betManager.adjust(delta, this.wallet.getBalance());
    this.bus.emit('game:stateChange', this.snapshot());
    return amount;
  }

  async startRound() {
    if (this._startLock) return;
    if (!this.canStartRound()) {
      if (!this.wallet.canAfford(this.betManager.getAmount())) {
        this.bus.emit('wallet:insufficient', { balance: this.wallet.getBalance() });
      }
      return;
    }

    this._startLock = true;
    if (!this._goto(GameState.STARTING)) {
      this._startLock = false;
      return;
    }

    this.betManager.lock();
    const bet = this.betManager.getAmount();
    const roundResult = this.randomResultGenerator.generateRoundResult();
    const flightPlan = this.flightController.generateFlightPath(roundResult);
    const multiplier = this.multiplierSystem.bind(roundResult, flightPlan);
    const round = this.roundManager.create({
      bet,
      generated: roundResult,
      flightPlan,
      multiplier,
      roundNumber: this.history.nextNumber(),
    });

    this._debitBetOnce(round);
    this.bus.emit('wallet:changed', { balance: this.wallet.getBalance() });

    this.flightController.load(flightPlan);
    this.landingSequence.reset();
    this.physics.reset({
      distance: this.config.flight.path.startPosition.distance,
      altitude: this.config.flight.path.startPosition.altitude,
      pitch: 0,
      phase: 'TAKEOFF',
      t: 0,
    });
    this.numberField.spawn(round.id, flightPlan);
    this.rocketField.spawn(round.id, flightPlan);
    const planeRadius = this.config.numberPickups?.planeRadius ?? 18;
    this.flightController.aircraft.collider.radius = planeRadius;
    this._prevPlane = {
      x: this.config.flight.path.startPosition.distance,
      y: this.config.flight.path.startPosition.altitude,
      radius: planeRadius,
    };
    this.animationController.prepareRound(this.numberField, this.rocketField);
    this.bus.emit('round:created', { id: round.id, bet, roundNumber: round.roundNumber });
    await new Promise((resolve) => requestAnimationFrame(resolve));

    if (!this._goto(GameState.TAKEOFF)) {
      this._startLock = false;
      return;
    }

    this.audioManager.playEngine();
    await this._runFlight();
    this._advanceFlightPhase(GameState.DESCENT);

    const finale = round.result === 'SUCCESS' ? GameState.LANDING : GameState.CRASH;
    this._goto(finale);
    const handoff = this.flightController.handoff();
    this.landingSequence.begin(
      {
        ...handoff,
        distance: this.physics.body.x,
        altitude: this.physics.body.y,
        pitch: this.physics.body.rotation,
        vx: this.physics.body.vx,
        vy: this.physics.body.vy,
        speed: Math.hypot(this.physics.body.vx, this.physics.body.vy),
      },
      roundResult,
      flightPlan,
    );
    await this._runLanding();

    this.roundManager.markEnded();
    this._goto(GameState.RESULT);
    this.audioManager.stopEngine();
    this.bus.emit('landing:complete', { result: round.result });

    let winAmount = 0;
    if (round.result === 'SUCCESS') {
      this.audioManager.playSuccess();
      await delay(this.config.landingResultDelayMs ?? 360);
      winAmount = this.multiplierSystem.payout(bet);
      this._creditWinOnce(round, winAmount);
    } else {
      this.audioManager.playFail();
    }

    const balanceAfter = this.wallet.getBalance();
    const record = {
      roundNumber: round.roundNumber,
      bet,
      result: round.result,
      multiplier: round.multiplier,
      winAmount,
      winLoss: round.result === 'SUCCESS' ? winAmount : -bet,
      balanceAfter,
    };
    this.history.push(record);
    this.bus.emit('wallet:changed', { balance: balanceAfter });
    this.bus.emit('history:updated', this.history.list());
    if (round.result === 'SUCCESS') {
      this.bus.emit('round:success', { ...record, payout: winAmount });
    } else {
      this.bus.emit('round:fail', record);
    }
    this.bus.emit('round:complete', record);

    await delay(this.settings.roundResetDelayMs);
    this._goto(GameState.RESET);
    this.roundManager.clear();
    this.betManager.unlock();
    this.landingSequence.reset();
    this.numberField.clear();
    this.rocketField.clear();
    this.physics.reset(this._idlePose());
    this._prevPlane = null;
    this.animationController.returnToIdle(this._idlePose());
    this._goto(GameState.IDLE);
    this._startLock = false;
  }

  resetWallet() {
    if (!isPreRoundState(this.state) || this._startLock) return;
    this.wallet.reset();
    this.bus.emit('wallet:changed', { balance: this.wallet.getBalance() });
  }

  _enterBetting() {
    if (this.state === GameState.IDLE) this._goto(GameState.BETTING);
  }

  _debitBetOnce(round) {
    if (!this.roundManager.markBetDebited()) return false;
    this.wallet.placeBet(round.bet, round.id);
    return true;
  }

  _creditWinOnce(round, winAmount) {
    if (this.state !== GameState.RESULT) return false;
    if (!this.roundManager.markWinCredited()) return false;
    this.wallet.creditWin(winAmount, round.id);
    return true;
  }

  _advanceFlightPhase(phase) {
    const target = FLIGHT_PHASE_ORDER.includes(phase) ? phase : null;
    if (!target) return;
    const from = FLIGHT_PHASE_ORDER.indexOf(this.state);
    const to = FLIGHT_PHASE_ORDER.indexOf(target);
    if (from < 0 || to < 0 || to <= from) return;
    for (let i = from + 1; i <= to; i += 1) {
      this._goto(FLIGHT_PHASE_ORDER[i]);
    }
  }

  _runFlight() {
    return new Promise((resolve) => {
      let last = performance.now();
      const tick = (now) => {
        const rawDt = Math.min((now - last) / 1000, this.config.flight.path.maxDt);
        const dt = rawDt * this.settings.playbackSpeed;
        last = now;
        const guide = this.flightController.update(dt);
        this._advanceFlightPhase(guide.phase);
        this._collectWorldHits(this.physics.snapshot(guide), dt);
        const pose = this.physics.follow(guide, dt, 'flight');
        const multiplier = this.multiplierSystem.sample(pose, dt);
        this.animationController.show(pose);
        this.audioManager.setEngineFromSpeed(pose.speed);
        this._cueMotionAudio(pose);
        this.bus.emit('flight:tick', { ...pose, multiplier: multiplier.value, multiplierInfo: multiplier });
        if (this.flightController.isComplete() || this.physics.hitsWater(this.flightController.ship)) {
          resolve();
          return;
        }
        this._flightRaf = requestAnimationFrame(tick);
      };
      this._flightRaf = requestAnimationFrame(tick);
    });
  }

  _runLanding() {
    return new Promise((resolve) => {
      let last = performance.now();
      const tick = (now) => {
        const rawDt = Math.min((now - last) / 1000, this.config.flight.path.maxDt);
        const dt = rawDt * this.settings.playbackSpeed;
        last = now;
        this._collectWorldHits(this.physics.snapshot(), dt);
        const guide = this.landingSequence.update(dt);
        const mode = this.state === GameState.CRASH || guide.phase === 'CRASH' ? 'crash' : 'landing';
        const pose = this.physics.follow(guide, dt, mode);
        this.landingSequence.resolveSurfaces();
        const multiplier = this.multiplierSystem.sample(pose, dt);
        this.animationController.show(pose);
        this.audioManager.setEngineFromSpeed(pose.speed);
        this._cueMotionAudio(pose);
        this.bus.emit('flight:tick', { ...pose, multiplier: multiplier.value, multiplierInfo: multiplier });
        if (this.landingSequence.isComplete()) {
          resolve();
          return;
        }
        this._flightRaf = requestAnimationFrame(tick);
      };
      this._flightRaf = requestAnimationFrame(tick);
    });
  }

  _collectWorldHits(pose, dt) {
    const collider = this.physics.body.collider;
    collider.setPosition(pose.distance, pose.altitude);
    this.numberField.update(dt);
    this.rocketField.update(dt);
    const prev = this.physics.prev;
    const numberHits = this.numberField.collectHits(collider, prev);
    const rocketHits = this.rocketField.collectHits(collider, prev);
    this._prevPlane = { x: pose.distance, y: pose.altitude, radius: collider.radius };
    const zone = this.flightController.ship?.zoneCollider;
    if (zone) {
      pose.zoneContact = this.physics.overlapsZone(zone, prev);
    }
    const zoneStart = this.config.roundResult?.landingZone?.start ?? this.config.flight?.world?.shipDistance ?? 1280;
    const overDeck = this.physics.body.x >= zoneStart - 14;
    const allowFlightHits = this.state !== GameState.RESULT && !overDeck;
    for (const item of numberHits) {
      const applied = this.multiplierSystem.onMultiplierNumberHit(item.number, { id: item.id });
      if (!applied) continue;
      if (allowFlightHits) this.physics.applyNumberHit(item);
      this.animationController.onNumberHit?.(item, applied);
      this.bus.emit('multiplier:hit', { ...applied, id: item.id });
    }
    for (const rocket of rocketHits) {
      const applied = this.multiplierSystem.onRocketHit(rocket);
      if (allowFlightHits) {
        this.physics.applyRocketHit(rocket);
      }
      this.animationController.onRocketHit?.(rocket, applied);
      this.bus.emit('rocket:hit', { rocket, ...(applied ?? {}) });
    }
    if (this.state === GameState.CRASH) {
      const water = this.flightController.ship?.waterCollider;
      if (this.physics.hitsWater(this.flightController.ship) || (water && this.physics.overlapsZone(water, prev))) {
        if (this.landingSequence.onAircraftWaterImpact()) {
          this.bus.emit('aircraft:waterImpact', {
            distance: pose.distance,
            altitude: pose.altitude,
          });
        }
      }
    }
  }

  _cueMotionAudio(pose) {
    if (pose?.effects?.touchdownPulse) this.audioManager.playLanding();
    if (pose?.effects?.splashPulse) this.audioManager.playCrash();
  }

  _idlePose() {
    const world = this.config.flight.world;
    return {
      t: 0,
      distance: world.startDistance,
      altitude: world.startAltitude,
      speed: 0,
      pitch: 0,
      x: world.startDistance,
      y: world.startAltitude,
      phase: 'idle',
    };
  }

  _loop(last) {
    const step = (now) => {
      this.animationController.render(now - last);
      last = now;
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  _goto(next) {
    const change = this.machine.transition(next);
    if (!change) {
      this.bus.emit('game:illegalTransition', { from: this.state, to: next });
      return false;
    }
    this.bus.emit('game:stateChange', this.snapshot());
    return true;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
