import { gameConfig } from './config/gameConfig.js?v=one-ship';
import { EventBus } from './utils/EventBus.js';
import { SettingsManager } from './core/SettingsManager.js';
import { RandomResultGenerator } from './core/RandomResultGenerator.js';
import { RoundManager } from './core/RoundManager.js';
import { GameManager } from './core/GameManager.js';
import { Aircraft } from './flight/Aircraft.js';
import { Ship } from './flight/Ship.js';
import { FlightController } from './flight/FlightController.js';
import { MultiplierSystem } from './flight/MultiplierSystem.js';
import { AnimationController } from './flight/AnimationController.js?v=one-ship';
import { LandingSequence } from './flight/LandingSequence.js';
import { Wallet } from './economy/Wallet.js';
import { BetManager } from './economy/BetManager.js';
import { AudioManager } from './audio/AudioManager.js';
import { GameHistory } from './history/GameHistory.js';
import { UIManager } from './ui/UIManager.js';

const bus = new EventBus();
const settings = new SettingsManager(gameConfig);
const wallet = new Wallet(gameConfig);
const betManager = new BetManager(gameConfig, settings);
const history = new GameHistory(gameConfig);
const audioManager = new AudioManager(settings);
const aircraft = new Aircraft();
const ship = new Ship(gameConfig.flight.world, gameConfig.roundResult.landingZone);
const flightController = new FlightController(gameConfig, aircraft, ship);
const landingSequence = new LandingSequence(gameConfig, aircraft, ship);
const multiplierSystem = new MultiplierSystem(gameConfig);
const animationController = new AnimationController(
  document.querySelector('#viewport'),
  aircraft,
  ship,
  gameConfig,
);

const gameManager = new GameManager({
  wallet,
  betManager,
  roundManager: new RoundManager(),
  randomResultGenerator: new RandomResultGenerator(gameConfig),
  flightController,
  landingSequence,
  multiplierSystem,
  animationController,
  audioManager,
  history,
  settings,
  bus,
  config: gameConfig,
});

const uiManager = new UIManager({
  root: document.querySelector('.app'),
  bus,
  config: gameConfig,
  betManager,
  settings,
  gameManager,
});

document.addEventListener(
  'pointerdown',
  () => {
    audioManager.unlock();
  },
  { once: true },
);

gameManager.start();
void uiManager;

animationController.ready.catch((error) => {
  console.warn('Scene assets failed to load, using fallback drawing.', error);
});
