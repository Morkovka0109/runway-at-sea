/**
 * Explicit game state machine. Illegal transitions are rejected, never applied.
 */
export class StateMachine {
  constructor({ initial, transitions }) {
    this.state = initial;
    this.transitions = transitions;
  }

  can(next) {
    return (this.transitions[this.state] ?? []).includes(next);
  }

  transition(next) {
    if (next === this.state) return false;
    if (!this.can(next)) return false;
    const from = this.state;
    this.state = next;
    return { from, to: next };
  }
}
