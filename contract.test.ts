import { describe, it, expect } from 'vitest';
import * as studio from './studio.mjs';
import { STUDIO_ACTIONS } from './studio-api.mjs';
import {
  CONTRACT_ROUTE_COUNT,
  CONTRACT_MD_ROUTE_COUNT,
  STUDIO_API_ROUTE_COUNT,
  CONTRACT_ROUTES,
  STUDIO_COMMAND_ALIASES,
  aliasArgs,
  formatConformanceReport,
  routeForAction,
  validateContractConformance,
} from './contract.mjs';

describe('CONTRACT routes', () => {
  it('defines 68 CONTRACT.md routes plus control-panel supplements', () => {
    expect(CONTRACT_MD_ROUTE_COUNT).toBe(68);
    expect(STUDIO_API_ROUTE_COUNT).toBe(69);
    expect(CONTRACT_ROUTE_COUNT).toBe(69);
    expect(CONTRACT_ROUTES).toHaveLength(69);
    const ids = CONTRACT_ROUTES.map((r) => r.id);
    expect(ids).toEqual([...Array(69)].map((_, i) => i + 1));
  });

  it('every route has at least one Slate surface', () => {
    for (const r of CONTRACT_ROUTES) {
      expect(r.commands.length + r.actions.length, `#${r.id} ${r.path}`).toBeGreaterThan(0);
    }
  });

  it('attachment-only routes have no !api action', () => {
    const attachmentOnly = [25, 38, 39, 68];
    for (const id of attachmentOnly) {
      const r = CONTRACT_ROUTES.find((x) => x.id === id)!;
      expect(r.actions, `#${id}`).toEqual([]);
      expect(r.commands.length, `#${id}`).toBeGreaterThan(0);
    }
  });
});

describe('validateContractConformance', () => {
  it('passes against current studio.mjs and STUDIO_ACTIONS', () => {
    const result = validateContractConformance(studio, STUDIO_ACTIONS);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    expect(result.ok).toBe(true);
  });

  it('maps every STUDIO_ACTION (except help) to a route', () => {
    for (const key of Object.keys(STUDIO_ACTIONS)) {
      if (key === 'help') continue;
      expect(routeForAction(key), `action ${key}`).toBeTruthy();
    }
  });

  it('includes render retry (control panel parity)', () => {
    const retry = CONTRACT_ROUTES.find((r) => r.id === 69)!;
    expect(retry.path).toBe('/api/storyboard/renders/:id/retry');
    expect(retry.actions).toContain('render-retry');
    expect(retry.commands).toContain('!retry');
  });
});

describe('STUDIO_COMMAND_ALIASES', () => {
  it('every alias targets a valid action', () => {
    for (const [cmd, alias] of Object.entries(STUDIO_COMMAND_ALIASES)) {
      expect(STUDIO_ACTIONS[alias.action], `!${cmd}`).toBeTruthy();
    }
  });

  it('builds poll args', () => {
    expect(aliasArgs(STUDIO_COMMAND_ALIASES.poll, 'job-1 score-music')).toBe('id:job-1 module:score-music');
    expect(aliasArgs(STUDIO_COMMAND_ALIASES.regen, 'r1 s2')).toBe('id:r1 shotId:s2');
    expect(aliasArgs(STUDIO_COMMAND_ALIASES.refine, 'tighter pacing')).toBe('message:tighter pacing');
  });
});

describe('formatConformanceReport', () => {
  it('includes all route ids', () => {
    const text = formatConformanceReport({ compact: true });
    for (let i = 1; i <= STUDIO_API_ROUTE_COUNT; i++) {
      expect(text).toContain(`#${i}`);
    }
  });
});
