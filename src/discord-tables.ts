import type { APIEmbed } from 'discord.js';

export interface SplitForDiscord {
  text: string;
  embeds: APIEmbed[];
}

const DISCORD_BLURPLE = 0x5865f2;

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length >= 2;
}

function isSeparatorRow(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = splitRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.slice(1, -1);
  return inner.split('|').map((c) => c.trim());
}

function padRow(row: string[], width: number): string[] {
  if (row.length >= width) return row.slice(0, width);
  const out = [...row];
  while (out.length < width) out.push('');
  return out;
}

function buildEmbed(
  header: string[],
  rows: string[][],
  rawTable: string,
): APIEmbed {
  if (header.length > 3 || rows.length > 25) {
    return {
      color: DISCORD_BLURPLE,
      description: '```\n' + rawTable + '\n```',
    };
  }

  const fields = rows.map((row) => {
    const padded = padRow(row, header.length);
    if (header.length === 1) {
      return { name: padded[0] || '​', value: '​', inline: false };
    }
    const name = padded[0] || '​';
    const valueParts: string[] = [];
    for (let i = 1; i < header.length; i++) {
      const cell = padded[i];
      if (!cell) continue;
      valueParts.push(`**${header[i]}:** ${cell}`);
    }
    const value = valueParts.length > 0 ? valueParts.join(' · ') : '​';
    return { name, value, inline: false };
  });

  return { color: DISCORD_BLURPLE, fields };
}

export function splitMarkdownTables(input: string): SplitForDiscord {
  const lines = input.split('\n');
  const outLines: string[] = [];
  const embeds: APIEmbed[] = [];
  let inFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      outLines.push(line);
      i++;
      continue;
    }

    if (
      !inFence &&
      isTableRow(line) &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      const header = splitRow(line);
      const rawLines = [line, lines[i + 1]];
      const bodyRows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j]) && !isSeparatorRow(lines[j])) {
        bodyRows.push(splitRow(lines[j]));
        rawLines.push(lines[j]);
        j++;
      }
      embeds.push(buildEmbed(header, bodyRows, rawLines.join('\n')));
      outLines.push('');
      i = j;
      continue;
    }

    outLines.push(line);
    i++;
  }

  if (embeds.length === 0) return { text: input, embeds: [] };

  const text = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, embeds };
}
