import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { startLivenessMonitor } from './liveness.js';
import { Channel } from './types.js';

function fakeChannel(name: string, connected: () => boolean): Channel {
  return {
    name,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: connected,
    sendMessage: async () => {},
    ownsJid: () => false,
  };
}

describe('startLivenessMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not exit during the startup grace period even if channels are down', () => {
    let now = 1_000_000;
    const onFail = vi.fn();
    const ch = fakeChannel('whatsapp', () => false);

    const monitor = startLivenessMonitor([ch], {
      checkIntervalMs: 100,
      failThresholdMs: 200,
      startupGraceMs: 10_000,
      now: () => now,
      onFail,
    });

    // Advance well past the failThreshold but still inside grace.
    for (let step = 0; step < 50; step++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }

    expect(onFail).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('exits when a channel stays disconnected past the threshold (after grace)', () => {
    let now = 1_000_000;
    const onFail = vi.fn();
    const ch = fakeChannel('whatsapp', () => false);

    startLivenessMonitor([ch], {
      checkIntervalMs: 100,
      failThresholdMs: 500,
      startupGraceMs: 0,
      now: () => now,
      onFail,
    });

    // First tick records firstDownAt=now.
    now += 100;
    vi.advanceTimersByTime(100);
    expect(onFail).not.toHaveBeenCalled();

    // Walk past the threshold.
    for (let step = 0; step < 10; step++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('does not exit if a disconnected channel comes back within the threshold', () => {
    let now = 1_000_000;
    let connected = false;
    const onFail = vi.fn();
    const ch = fakeChannel('discord', () => connected);

    startLivenessMonitor([ch], {
      checkIntervalMs: 100,
      failThresholdMs: 500,
      startupGraceMs: 0,
      now: () => now,
      onFail,
    });

    // 300ms disconnected
    for (let step = 0; step < 3; step++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    // Reconnect
    connected = true;
    now += 100;
    vi.advanceTimersByTime(100);

    // Now stay disconnected again — timer should reset, not carry over.
    connected = false;
    for (let step = 0; step < 4; step++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }

    expect(onFail).not.toHaveBeenCalled();
  });

  it('tracks each channel independently — one bad channel triggers exit', () => {
    let now = 1_000_000;
    const onFail = vi.fn();
    const whatsapp = fakeChannel('whatsapp', () => true);
    const discord = fakeChannel('discord', () => false);

    startLivenessMonitor([whatsapp, discord], {
      checkIntervalMs: 100,
      failThresholdMs: 500,
      startupGraceMs: 0,
      now: () => now,
      onFail,
    });

    for (let step = 0; step < 10; step++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }

    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('only fires onFail once even if checks keep running', () => {
    let now = 1_000_000;
    const onFail = vi.fn();
    const ch = fakeChannel('whatsapp', () => false);

    startLivenessMonitor([ch], {
      checkIntervalMs: 100,
      failThresholdMs: 200,
      startupGraceMs: 0,
      now: () => now,
      onFail,
    });

    for (let step = 0; step < 20; step++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels future ticks', () => {
    let now = 1_000_000;
    const onFail = vi.fn();
    const ch = fakeChannel('whatsapp', () => false);

    const monitor = startLivenessMonitor([ch], {
      checkIntervalMs: 100,
      failThresholdMs: 200,
      startupGraceMs: 0,
      now: () => now,
      onFail,
    });

    monitor.stop();
    for (let step = 0; step < 20; step++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    expect(onFail).not.toHaveBeenCalled();
  });
});
