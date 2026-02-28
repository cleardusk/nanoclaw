import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { logger } from './logger.js';
import {
  parseNodeMajor,
  warnIfNodeVersionNotRecommended,
} from './runtime-checks.js';

describe('runtime-checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns for Node 22+', () => {
    warnIfNodeVersionNotRecommended('22.17.0');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for Node 20/21', () => {
    warnIfNodeVersionNotRecommended('20.18.1');
    warnIfNodeVersionNotRecommended('21.7.3');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('parses major version safely', () => {
    expect(parseNodeMajor('20.12.2')).toBe(20);
    expect(parseNodeMajor('abc')).toBeNull();
  });
});
