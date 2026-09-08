import { GameState, isFlightState, isPreRoundState } from '../core/GameState.js';
import { roundTo } from '../utils/easing.js';

const STATE_VIEW = {
  IDLE: { label: 'Готов', tone: 'ready' },
  BETTING: { label: 'Ставка', tone: 'ready' },
  STARTING: { label: 'Старт', tone: 'fly' },
  TAKEOFF: { label: 'Взлёт', tone: 'fly' },
  CLIMB: { label: 'Набор', tone: 'fly' },
  CRUISE: { label: 'Курс', tone: 'fly' },
  DESCENT: { label: 'Снижение', tone: 'fly' },
  LANDING: { label: 'Посадка', tone: 'land' },
  CRASH: { label: 'Срыв', tone: 'land' },
  RESULT: { label: 'Финиш', tone: 'done' },
  RESET: { label: 'Сброс', tone: 'done' },
};

export class UIManager {
  constructor({ root, bus, config, betManager, settings, gameManager }) {
    this.root = root;
    this.bus = bus;
    this.config = config;
    this.betManager = betManager;
    this.settings = settings;
    this.gameManager = gameManager;
    this.els = {
      balance: root.querySelector('#balance-value'),
      roundNumber: root.querySelector('#round-number'),
      stateChip: root.querySelector('#state-chip'),
      betInput: root.querySelector('#bet-input'),
      play: root.querySelector('#play-button'),
      betMinus: root.querySelector('#bet-minus'),
      betPlus: root.querySelector('#bet-plus'),
      presets: root.querySelector('#bet-presets'),
      altitude: root.querySelector('#stat-altitude'),
      distance: root.querySelector('#stat-distance'),
      speed: root.querySelector('#stat-speed'),
      multiplier: root.querySelector('#stat-multiplier'),
      result: root.querySelector('#result-banner'),
      resultKicker: root.querySelector('#result-kicker'),
      resultMain: root.querySelector('#result-main'),
      resultSub: root.querySelector('#result-sub'),
      history: root.querySelector('#history-list'),
      historyEmpty: root.querySelector('#history-empty'),
      sound: root.querySelector('#sound-toggle'),
      playbackSpeed: root.querySelector('#speed-select'),
      reset: root.querySelector('#reset-wallet'),
      status: root.querySelector('#round-status'),
    };
    this.lastOutcome = null;
    this._bind();
    this._bindEvents();
  }

  _maxAffordable() {
    return this.gameManager.wallet.getBalance();
  }

  _bind() {
    this.els.play.addEventListener('click', () => {
      if (this.els.play.disabled) return;
      this.els.play.disabled = true;
      this.gameManager.startRound();
    });
    this.els.betMinus.addEventListener('click', () => {
      this.gameManager.adjustBet(-this.config.betting.step);
      this.renderBet();
    });
    this.els.betPlus.addEventListener('click', () => {
      this.gameManager.adjustBet(this.config.betting.step);
      this.renderBet();
    });
    this.els.betInput.addEventListener('change', () => {
      this.gameManager.setBet(this.els.betInput.value);
      this.renderBet();
    });
    this.els.presets.addEventListener('click', (event) => {
      const button = event.target.closest('[data-bet]');
      if (!button || !this.gameManager.canChangeBet()) return;
      this.gameManager.setBet(Number(button.dataset.bet));
      this.renderBet();
    });
    this.els.sound.addEventListener('click', () => {
      const enabled = this.settings.toggleSound();
      this.renderSettings();
      this.bus.emit('settings:changed', { soundEnabled: enabled });
    });
    this.els.playbackSpeed.addEventListener('change', () => {
      this.settings.setPlaybackSpeed(Number(this.els.playbackSpeed.value));
    });
    this.els.reset.addEventListener('click', () => this.gameManager.resetWallet());
  }

  _bindEvents() {
    this.bus.on('game:ready', (snap) => this.renderAll(snap));
    this.bus.on('game:stateChange', (snap) => this.renderState(snap));
    this.bus.on('wallet:changed', ({ balance }) => this.renderBalance(balance));
    this.bus.on('wallet:insufficient', () => this.flashStatus('Мало фишек'));
    this.bus.on('flight:tick', (sample) => this.renderFlight(sample));
    this.bus.on('round:success', (summary) => this.showResult(true, summary));
    this.bus.on('round:fail', (summary) => this.showResult(false, summary));
    this.bus.on('landing:complete', ({ result }) => this.showLandingHeadline(result === 'SUCCESS'));
    this.bus.on('history:updated', (list) => this.renderHistory(list));
    this.bus.on('multiplier:hit', () => this.pulseMultiplier(false));
    this.bus.on('rocket:hit', () => this.pulseMultiplier(true));
    this.bus.on('round:created', ({ roundNumber } = {}) => {
      this.lastOutcome = null;
      this.hideResult();
      if (roundNumber) this.els.roundNumber.textContent = String(roundNumber);
    });
  }

  renderAll(snap) {
    this.lastOutcome = snap.history[0]?.result ?? null;
    this.renderBalance(snap.balance);
    this.renderBet();
    this.renderSettings();
    this.renderHistory(snap.history);
    this.renderState(snap);
    this.renderFlight({
      altitude: this.config.flight.world.startAltitude,
      distance: 0,
      speed: 0,
      multiplier: this.config.multiplier.start,
    });
  }

  renderBalance(balance) {
    this.els.balance.textContent = formatChips(balance);
  }

  renderBet() {
    const amount = this.betManager.getAmount();
    this.els.betInput.value = String(amount);
    for (const button of this.els.presets.querySelectorAll('[data-bet]')) {
      button.classList.toggle('is-active', Number(button.dataset.bet) === amount);
    }
  }

  renderSettings() {
    this.els.sound.textContent = this.settings.soundEnabled ? 'Звук вкл' : 'Звук выкл';
    this.els.playbackSpeed.value = String(this.settings.playbackSpeed);
  }

  renderState(snap) {
    const flying = isFlightState(snap.state) || snap.state === GameState.LANDING || snap.state === GameState.CRASH;
    const busy = !isPreRoundState(snap.state);
    this.els.play.disabled = busy || snap.balance < snap.bet;
    this.els.play.textContent = playLabel(snap.state);
    const betLocked = busy || snap.locked;
    this.els.betMinus.disabled = betLocked;
    this.els.betPlus.disabled = betLocked;
    this.els.betInput.disabled = betLocked;
    for (const button of this.els.presets.querySelectorAll('[data-bet]')) {
      button.disabled = betLocked;
    }
    this.root.dataset.state = snap.state;
    this.els.roundNumber.textContent = String(snap.roundNumber ?? 1);
    this._renderStateChip(snap);
    if (snap.state === GameState.IDLE) {
      this.renderFlight({
        altitude: this.config.flight.world.startAltitude,
        distance: 0,
        speed: 0,
        multiplier: this.config.multiplier.start,
      });
    }
  }

  _renderStateChip(snap) {
    const view = STATE_VIEW[snap.state] ?? STATE_VIEW.IDLE;
    this.els.status.textContent = view.label;
    this.els.stateChip.className = `state-chip is-${view.tone}`;
    if (snap.state === GameState.RESULT || (snap.state === GameState.IDLE && this.lastOutcome)) {
      const win = (snap.lastResult ?? this.lastOutcome) === 'SUCCESS';
      this.els.stateChip.classList.add('is-done', win ? 'is-win' : 'is-fail');
      if (snap.state === GameState.IDLE && this.lastOutcome) {
        this.els.status.textContent = win ? 'Победа' : 'Поражение';
      }
    }
  }

  renderFlight(sample) {
    this.els.altitude.textContent = `${Math.max(0, sample.altitude).toFixed(0)} м`;
    this.els.distance.textContent = `${Math.max(0, sample.distance).toFixed(0)} м`;
    this.els.speed.textContent = `${Math.max(0, sample.speed).toFixed(0)} уз`;
    this.els.multiplier.textContent = `×${Number(sample.multiplier).toFixed(2)}`;
  }

  pulseMultiplier(hurt = false) {
    const el = this.els.multiplier.closest('.stat-multiplier') ?? this.els.multiplier;
    el.classList.remove('is-hit', 'is-hurt');
    void el.offsetWidth;
    el.classList.add(hurt ? 'is-hurt' : 'is-hit');
  }

  renderHistory(list) {
    this.els.history.replaceChildren();
    const recent = list.slice(0, 8);
    const empty = !recent.length;
    this.els.historyEmpty.hidden = !empty;
    if (empty) return;

    for (const entry of recent) {
      const chip = document.createElement('article');
      const win = entry.result === 'SUCCESS';
      chip.className = `recent-chip ${win ? 'is-win' : 'is-fail'}`;
      const round = document.createElement('b');
      round.textContent = `#${entry.roundNumber}`;
      const line = document.createElement('span');
      line.textContent = win
        ? `WIN ×${Number(entry.multiplier).toFixed(2)}`
        : `FAIL ${formatSigned(entry.winLoss)}`;
      chip.append(round, line);
      this.els.history.append(chip);
    }
  }

  showLandingHeadline(success) {
    this.lastOutcome = success ? 'SUCCESS' : 'FAIL';
    this.els.result.hidden = false;
    this.els.result.classList.toggle('is-success', success);
    this.els.result.classList.toggle('is-fail', !success);
    this.els.resultKicker.textContent = success ? 'SUCCESS' : 'FAIL';
    this.els.resultMain.textContent = success ? 'Посадка' : 'Промах';
    this.els.resultSub.textContent = success ? 'Считаем выигрыш…' : 'Ставка потеряна';
  }

  showResult(success, summary) {
    this.lastOutcome = success ? 'SUCCESS' : 'FAIL';
    this.els.result.hidden = false;
    this.els.result.classList.toggle('is-success', success);
    this.els.result.classList.toggle('is-fail', !success);
    this.els.resultKicker.textContent = success ? 'SUCCESS' : 'FAIL';
    if (success) {
      const payout = summary.payout ?? summary.winAmount;
      this.els.resultMain.textContent = `+${formatChips(payout)}`;
      this.els.resultSub.textContent = `Коэффициент ×${Number(summary.multiplier).toFixed(2)}`;
    } else {
      this.els.resultMain.textContent = `−${formatChips(summary.bet)}`;
      this.els.resultSub.textContent = 'Ставка не вернулась';
    }
  }

  hideResult() {
    this.els.result.hidden = true;
  }

  flashStatus(text) {
    this.els.status.textContent = text;
  }
}

function formatChips(value) {
  return `${roundTo(Number(value) || 0, 2).toLocaleString('ru-RU')} VC`;
}

function formatSigned(value) {
  const amount = roundTo(Number(value) || 0, 2);
  const sign = amount > 0 ? '+' : '';
  return `${sign}${amount.toLocaleString('ru-RU')} VC`;
}

function playLabel(state) {
  if (isPreRoundState(state)) return 'START';
  if (isFlightState(state) || state === GameState.STARTING) return 'ПОЛЁТ';
  if (state === GameState.LANDING) return 'ПОСАДКА';
  if (state === GameState.CRASH) return 'СРЫВ';
  return 'РАУНД';
}
