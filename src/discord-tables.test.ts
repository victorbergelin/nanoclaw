import { describe, it, expect } from 'vitest';

import { splitMarkdownTables } from './discord-tables.js';

describe('splitMarkdownTables', () => {
  it('returns input unchanged when no table is present', () => {
    const input = 'just some prose\nwith two lines';
    const result = splitMarkdownTables(input);
    expect(result.text).toBe(input);
    expect(result.embeds).toEqual([]);
  });

  it('converts a single 2-column table to one embed and strips it', () => {
    const input = [
      'before',
      '| name | val |',
      '|------|-----|',
      '| a | 1 |',
      '| b | 2 |',
      'after',
    ].join('\n');
    const result = splitMarkdownTables(input);
    expect(result.embeds).toHaveLength(1);
    const embed = result.embeds[0];
    expect(embed.color).toBe(0x5865f2);
    expect(embed.fields).toEqual([
      { name: 'a', value: '**val:** 1', inline: false },
      { name: 'b', value: '**val:** 2', inline: false },
    ]);
    expect(result.text).toContain('before');
    expect(result.text).toContain('after');
    expect(result.text).not.toContain('| name |');
    expect(result.text).not.toContain('|------|');
  });

  it('joins values with bold headers for a 3-column table', () => {
    const input = [
      '| h1 | h2 | h3 |',
      '|----|----|----|',
      '| a | b | c |',
    ].join('\n');
    const result = splitMarkdownTables(input);
    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].fields).toEqual([
      { name: 'a', value: '**h2:** b · **h3:** c', inline: false },
    ]);
  });

  it('wraps >3 column tables in an inline code fence and emits no embed', () => {
    const input = [
      'before',
      '| a | b | c | d | e |',
      '|---|---|---|---|---|',
      '| 1 | 2 | 3 | 4 | 5 |',
      'after',
    ].join('\n');
    const result = splitMarkdownTables(input);
    expect(result.embeds).toEqual([]);
    expect(result.text).toContain('```');
    expect(result.text).toContain('| 1 | 2 | 3 | 4 | 5 |');
    expect(result.text).toContain('before');
    expect(result.text).toContain('after');
  });

  it('leaves tables inside fenced code blocks untouched', () => {
    const input = ['```', '| a | b |', '|---|---|', '| 1 | 2 |', '```'].join(
      '\n',
    );
    const result = splitMarkdownTables(input);
    expect(result.embeds).toEqual([]);
    expect(result.text).toBe(input);
  });

  it('preserves prose around a stripped table separated by blank line', () => {
    const input = [
      'pre line one',
      'pre line two',
      '',
      '| h | v |',
      '|---|---|',
      '| x | y |',
      '',
      'post line',
    ].join('\n');
    const result = splitMarkdownTables(input);
    expect(result.embeds).toHaveLength(1);
    expect(result.text).toContain('pre line one');
    expect(result.text).toContain('pre line two');
    expect(result.text).toContain('post line');
    expect(result.text).not.toMatch(/\n{3,}/);
  });

  it('emits one embed per table when two are present', () => {
    const input = [
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'middle',
      '',
      '| c | d |',
      '|---|---|',
      '| 3 | 4 |',
    ].join('\n');
    const result = splitMarkdownTables(input);
    expect(result.embeds).toHaveLength(2);
    expect(result.text).toContain('middle');
  });
});
