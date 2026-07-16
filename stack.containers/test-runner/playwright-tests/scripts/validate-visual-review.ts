#!/usr/bin/env ts-node
import { visualRoutes } from '../utils/route-catalog';
import {
  validateVisualEvidenceManifest,
  visualEvidenceManifestPath,
} from '../utils/visual-evidence';

const screenshotRoot = process.env.PLAYWRIGHT_SCREENSHOTS_DIR || '/app/test-results/screenshots';
const manifestPath = visualEvidenceManifestPath(screenshotRoot);
const requireApproved = process.argv.includes('--require-approved');
const expectedHosts = visualRoutes.map((route) => route.host);

const manifest = validateVisualEvidenceManifest(manifestPath, expectedHosts, requireApproved);
const pending = expectedHosts.filter((host) => manifest.captures[host].review.status === 'pending');
const rejected = expectedHosts.filter((host) => manifest.captures[host].review.status === 'rejected');

console.log(`Validated ${expectedHosts.length} visual captures in ${manifestPath}`);
console.log(`Human review: ${pending.length} pending, ${rejected.length} rejected`);
if (!requireApproved && pending.length > 0) {
  console.log('Run the human-review gate with --require-approved after reviewers record approvals in visual-review.json.');
}
