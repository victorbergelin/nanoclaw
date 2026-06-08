import { Channel } from './types.js';
import { logger } from './logger.js';

export interface LivenessOptions {
  /** How often to poll channel state (ms). Default: 30_000. */
  checkIntervalMs?: number;
  /** Max time a channel may stay disconnected before we self-exit (ms). Default: 60_000. */
  failThresholdMs?: number;
  /** Grace period after start before failures become fatal (ms). Default: 60_000. */
  startupGraceMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
  /** Injected exit handler for tests. */
  onFail?: () => void;
}

/**
 * Watch the connected state of every channel and self-exit if any one of them
 * has been disconnected for longer than the threshold. launchd's KeepAlive
 * then restarts the process. Without this, a zombie state (process alive but
 * channels never reconnect after a network blip) was invisible to the
 * supervisor — we observed a 6-day silent run on June 2.
 */
export function startLivenessMonitor(
  channels: Channel[],
  opts: LivenessOptions = {},
): { stop: () => void } {
  const checkIntervalMs = opts.checkIntervalMs ?? 30_000;
  const failThresholdMs = opts.failThresholdMs ?? 60_000;
  const startupGraceMs = opts.startupGraceMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const onFail = opts.onFail ?? (() => process.exit(1));

  const startedAt = now();
  const firstDownAt = new Map<string, number>();
  let triggered = false;

  const tick = () => {
    if (triggered) return;
    const t = now();
    const inGrace = t - startedAt < startupGraceMs;

    for (const channel of channels) {
      if (channel.isConnected()) {
        firstDownAt.delete(channel.name);
        continue;
      }
      if (!firstDownAt.has(channel.name)) {
        firstDownAt.set(channel.name, t);
      }
      const downMs = t - firstDownAt.get(channel.name)!;
      if (!inGrace && downMs >= failThresholdMs) {
        logger.fatal(
          { channel: channel.name, downMs },
          'Channel disconnected past threshold, exiting for supervisor restart',
        );
        triggered = true;
        onFail();
        return;
      }
    }
  };

  const timer = setInterval(tick, checkIntervalMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
