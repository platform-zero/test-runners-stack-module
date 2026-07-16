import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  inspectVisualEvidence,
  readVisualEvidenceManifest,
  recordVisualEvidence,
  validateVisualEvidenceManifest,
} from '../../utils/visual-evidence';

function testJpeg(width = 1280, height = 720, seed = 1): Buffer {
  const buffer = Buffer.alloc(5000, seed);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  buffer[3] = 0xc0;
  buffer.writeUInt16BE(17, 4);
  buffer[6] = 8;
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  return buffer;
}

describe('visual evidence', () => {
  it('rejects tiny or undersized screenshot evidence', () => {
    expect(() => inspectVisualEvidence(testJpeg(200, 100))).toThrow(/dimensions are too small/);
    expect(() => inspectVisualEvidence(Buffer.from('not an image'))).toThrow(/not a JPEG/);
  });

  it('records automated evidence and requires an explicit human approval', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-evidence-'));
    const screenshotPath = path.join(root, 'screenshots', 'visual', 'portal.jpeg');
    const manifestPath = path.join(root, 'visual-review.json');
    const screenshot = testJpeg();
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, screenshot);

    const automated = inspectVisualEvidence(screenshot);
    recordVisualEvidence(manifestPath, 'portal', 'Portal', screenshotPath, automated);
    expect(readVisualEvidenceManifest(manifestPath).captures.portal.review.status).toBe('pending');
    expect(() => validateVisualEvidenceManifest(manifestPath, ['portal'], true)).toThrow(/requires human approval/);

    const manifest = readVisualEvidenceManifest(manifestPath);
    manifest.captures.portal.review = {
      status: 'approved',
      reviewer: 'human@example.test',
      reviewedAt: new Date().toISOString(),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(validateVisualEvidenceManifest(manifestPath, ['portal'], true).captures.portal.review.status).toBe('approved');

    expect(automated.sha256).toBe(crypto.createHash('sha256').update(screenshot).digest('hex'));
  });

  it('resets human approval when screenshot pixels change', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visual-evidence-reset-'));
    const screenshotPath = path.join(root, 'screenshots', 'portal.jpeg');
    const manifestPath = path.join(root, 'visual-review.json');
    const first = testJpeg(1280, 720, 1);
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    fs.writeFileSync(screenshotPath, first);
    recordVisualEvidence(manifestPath, 'portal', 'Portal', screenshotPath, inspectVisualEvidence(first));

    const approved = readVisualEvidenceManifest(manifestPath);
    approved.captures.portal.review = { status: 'approved', reviewer: 'reviewer' };
    fs.writeFileSync(manifestPath, JSON.stringify(approved));

    const second = testJpeg(1280, 720, 2);
    fs.writeFileSync(screenshotPath, second);
    recordVisualEvidence(manifestPath, 'portal', 'Portal', screenshotPath, inspectVisualEvidence(second));
    expect(readVisualEvidenceManifest(manifestPath).captures.portal.review.status).toBe('pending');
  });
});
