export const GameState = {
  IDLE: 'IDLE',
  BETTING: 'BETTING',
  STARTING: 'STARTING',
  TAKEOFF: 'TAKEOFF',
  CLIMB: 'CLIMB',
  CRUISE: 'CRUISE',
  DESCENT: 'DESCENT',
  LANDING: 'LANDING',
  CRASH: 'CRASH',
  RESULT: 'RESULT',
  RESET: 'RESET',
};

export const ALLOWED_TRANSITIONS = {
  [GameState.IDLE]: [GameState.BETTING, GameState.STARTING],
  [GameState.BETTING]: [GameState.IDLE, GameState.STARTING],
  [GameState.STARTING]: [GameState.TAKEOFF],
  [GameState.TAKEOFF]: [GameState.CLIMB],
  [GameState.CLIMB]: [GameState.CRUISE],
  [GameState.CRUISE]: [GameState.DESCENT],
  [GameState.DESCENT]: [GameState.LANDING, GameState.CRASH],
  [GameState.LANDING]: [GameState.RESULT],
  [GameState.CRASH]: [GameState.RESULT],
  [GameState.RESULT]: [GameState.RESET],
  [GameState.RESET]: [GameState.IDLE],
};

export const FLIGHT_PHASE_ORDER = [
  GameState.TAKEOFF,
  GameState.CLIMB,
  GameState.CRUISE,
  GameState.DESCENT,
];

export function isPreRoundState(state) {
  return state === GameState.IDLE || state === GameState.BETTING;
}

export function canChangeBetIn(state) {
  return isPreRoundState(state);
}

export function isFlightState(state) {
  return FLIGHT_PHASE_ORDER.includes(state);
}
