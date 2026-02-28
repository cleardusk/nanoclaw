import { logger } from './logger.js';

export function parseNodeMajor(version: string): number | null {
  const major = parseInt(version.split('.')[0], 10);
  return Number.isNaN(major) ? null : major;
}

export function warnIfNodeVersionNotRecommended(
  version: string = process.versions.node,
): void {
  const major = parseNodeMajor(version);
  if (major == null || major < 22) return;

  logger.warn(
    { nodeVersion: version, recommended: '20.x' },
    'Node.js 22+ detected. NanoClaw recommends Node.js 20.x (CI baseline). If you hit filesystem::equivalent errors, downgrade to Node 20.x and restart NanoClaw.',
  );
}
