import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(async (_group, _input, _onProcess, onOutput) => {
    await onOutput?.({ status: 'success', result: 'Skickat.' });
    return { status: 'success', result: 'Skickat.' };
  }),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./group-folder.js', async () => {
  const actual =
    await vi.importActual<typeof import('./group-folder.js')>(
      './group-folder.js',
    );
  return {
    ...actual,
    resolveGroupFolderPath: vi.fn((folder: string) => {
      if (folder.includes('..')) {
        throw new Error(`Path traversal detected: ${folder}`);
      }
      return `/tmp/nanoclaw-${folder}`;
    }),
  };
});

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('does not auto-forward result to guild-level Discord JIDs', async () => {
    createTask({
      id: 'task-guild-jid',
      group_folder: 'discord_main',
      chat_jid: 'dc:guild:1495871592486539374',
      prompt: 'briefing',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const sendMessage = vi.fn(async () => {});
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'dc:guild:1495871592486539374': {
          name: 'VB',
          folder: 'discord_main',
          trigger: '',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('forwards result to channel-level Discord JIDs', async () => {
    createTask({
      id: 'task-channel-jid',
      group_folder: 'discord_main',
      chat_jid: 'dc:1495883144513978599',
      prompt: 'briefing',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const sendMessage = vi.fn(async () => {});
    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'dc:1495883144513978599': {
          name: 'VB',
          folder: 'discord_main',
          trigger: '',
          added_at: '2026-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(sendMessage).toHaveBeenCalledWith(
      'dc:1495883144513978599',
      'Skickat.',
    );
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
