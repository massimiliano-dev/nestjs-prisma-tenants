export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive connectivity failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial request is allowed. Default 30 s. */
  resetTimeoutMs?: number;
  now?: () => number;
}

/**
 * Per-tenant circuit breaker. While open, requests for that tenant fail fast instead of
 * waiting on connection timeouts, so one broken database cannot slow everyone else down.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private stateValue: CircuitState = 'closed';
  private trialInFlight = false;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.stateValue === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.stateValue = 'half-open';
      this.trialInFlight = false;
    }
    return this.stateValue;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Whether a call may go through. In half-open state only one trial call is let through at a time. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  onSuccess(): void {
    this.failures = 0;
    this.trialInFlight = false;
    this.stateValue = 'closed';
  }

  /** Ends a half-open trial without counting it as success or failure. */
  releaseTrial(): void {
    this.trialInFlight = false;
  }

  onFailure(): void {
    this.failures += 1;
    this.trialInFlight = false;
    if (this.stateValue === 'half-open' || this.failures >= this.failureThreshold) {
      this.stateValue = 'open';
      this.openedAt = this.now();
    }
  }
}
