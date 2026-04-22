/**
 * Check-in sidecar — spawned via `container exec` inside an already-running
 * nanoclaw-agent container when the user sends `/ask <question>` from a
 * channel. Reads the question from a shared file, runs a SHORT, READ-ONLY
 * SDK query with a status-reporter system prompt, and writes the answer
 * back to a sibling file the host polls for.
 *
 * The main agent keeps running in the container's primary node process;
 * this sidecar is a second node process in the same VM, reads the same
 * filesystem, and talks to the same Anthropic credentials via the
 * credential proxy (env vars are inherited from the container spawn).
 *
 * Protocol:
 *   input  : /workspace/ipc/checkin/<id>.q.json  { question, contextJid? }
 *   output : /workspace/ipc/checkin/<id>.a.json  { answer?, error? }
 *
 * The sidecar is intentionally short-lived (single prompt, single turn)
 * and uses a light model so it comes back fast. Any longer task should
 * be sent to the primary agent via the normal message flow.
 */

import fs from 'fs';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

const CHECKIN_DIR = '/workspace/ipc/checkin';
const SIDECAR_TIMEOUT_MS = 90_000;

function log(msg: string): void {
  process.stderr.write(`[checkin] ${msg}\n`);
}

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    log('missing id argument');
    process.exit(2);
  }

  const questionPath = path.join(CHECKIN_DIR, `${id}.q.json`);
  const answerPath = path.join(CHECKIN_DIR, `${id}.a.json`);

  if (!fs.existsSync(questionPath)) {
    log(`no question file at ${questionPath}`);
    writeAnswer(answerPath, { error: 'no question file' });
    process.exit(2);
  }

  let payload: { question: string; contextJid?: string };
  try {
    payload = JSON.parse(fs.readFileSync(questionPath, 'utf-8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeAnswer(answerPath, { error: `bad question json: ${msg}` });
    process.exit(2);
  }

  const systemPreamble =
    `You are the status-reporter sidecar for the main nanoclaw agent. ` +
    `The main agent is busy in another process and cannot answer this ` +
    `question itself. You share the main agent's filesystem and tools ` +
    `but should stay READ-ONLY: do not modify files, send messages, or ` +
    `kick off long tool chains. Give a short, specific answer (<3 ` +
    `sentences unless the question clearly needs more). If you need ` +
    `recent chat history, use mcp__nanoclaw__get_messages or ` +
    `search_messages. If you do not know, say so.`;

  let answerText = '';
  const timeout = setTimeout(() => {
    writeAnswer(answerPath, {
      error: `sidecar timed out after ${SIDECAR_TIMEOUT_MS}ms`,
    });
    process.exit(1);
  }, SIDECAR_TIMEOUT_MS);

  try {
    for await (const message of query({
      prompt: payload.question,
      options: {
        cwd: '/workspace/group',
        // Light model — sidecar answers should be fast, not thorough.
        model: process.env.NANOCLAW_CHECKIN_MODEL || 'claude-haiku-4-5',
        systemPrompt: {
          type: 'preset' as const,
          preset: 'claude_code' as const,
          append: systemPreamble,
        },
        allowedTools: [
          'Read',
          'Glob',
          'Grep',
          'mcp__nanoclaw__list_conversations',
          'mcp__nanoclaw__get_messages',
          'mcp__nanoclaw__search_messages',
        ],
        // Intentionally skipping hooks, permissionMode bypass, and the full
        // mcpServers set — the sidecar only needs read-only introspection.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'result') {
        const text =
          'result' in message
            ? (message as { result?: string }).result
            : undefined;
        if (text) answerText = text;
      }
    }

    clearTimeout(timeout);
    if (!answerText) {
      writeAnswer(answerPath, { error: 'sidecar produced no result' });
      process.exit(1);
    }
    writeAnswer(answerPath, { answer: answerText });
    process.exit(0);
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error ? err.message : String(err);
    writeAnswer(answerPath, { error: msg });
    process.exit(1);
  }
}

function writeAnswer(dest: string, body: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, dest);
  } catch (err) {
    log(
      `writeAnswer failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

main().catch((err) => {
  log(`unhandled: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
