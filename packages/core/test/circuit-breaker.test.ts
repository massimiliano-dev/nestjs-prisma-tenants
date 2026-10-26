import { describe, expect, it } from 'vitest';
import { CircuitBreaker, isConnectivityError } from '../src/index.js';

describe('CircuitBreaker', () => {
  it('opens after the threshold, half-opens after the timeout and closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000, now: () => now });
    b.onFailure();
    b.onFailure();
    expect(b.state).toBe('closed');
    b.onFailure();
    expect(b.state).toBe('open');
    expect(b.tryAcquire()).toBe(false);

    now = 1000;
    expect(b.state).toBe('half-open');
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false); // one trial at a time
    b.onSuccess();
    expect(b.state).toBe('closed');
    expect(b.consecutiveFailures).toBe(0);
  });

  it('re-opens when the half-open trial fails', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => now });
    b.onFailure();
    now = 100;
    expect(b.tryAcquire()).toBe(true);
    b.onFailure();
    expect(b.state).toBe('open');
  });
});

describe('isConnectivityError', () => {
  it('recognises node, pg, prisma and adapter errors, also nested', () => {
    expect(isConnectivityError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isConnectivityError(Object.assign(new Error('x'), { code: '3D000' }))).toBe(true);
    expect(isConnectivityError(Object.assign(new Error('x'), { code: 'P1001' }))).toBe(true);
    expect(isConnectivityError({ name: 'PrismaClientInitializationError' })).toBe(true);
    expect(isConnectivityError(new Error('wrap', { cause: { kind: 'DatabaseNotReachable' } }))).toBe(true);
    expect(isConnectivityError(new AggregateError([Object.assign(new Error(), { code: 'ETIMEDOUT' })]))).toBe(
      true,
    );
  });

  it('ignores query and business errors', () => {
    expect(isConnectivityError(Object.assign(new Error('dup'), { code: '23505' }))).toBe(false);
    expect(isConnectivityError(Object.assign(new Error('nf'), { code: 'P2025' }))).toBe(false);
    expect(isConnectivityError(new Error('boom'))).toBe(false);
    expect(isConnectivityError(null)).toBe(false);
  });
});
