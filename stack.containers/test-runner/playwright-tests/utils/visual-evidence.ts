import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type VisualReviewStatus = 'pending' | 'approved' | 'rejected';

export interface VisualEvidenceCapture {
  routeHost: string;
  label: string;
  file: string;
  capturedAt: string;
  automated: {
    contentContractPassed: true;
    sha256: string;
    byteLength: number;
    width: number;
    height: number;
  };
  review: {
    status: VisualReviewStatus;
    reviewer?: string;
    reviewedAt?: string;
    notes?: string;
  };
}

export interface VisualEvidenceManifest {
  schemaVersion: 1;
  generatedAt: string;
  captures: Record<string, VisualEvidenceCapture>;
}

export function visualEvidenceManifestPath(screenshotRoot: string): string {
  return path.join(path.dirname(screenshotRoot), 'visual-review.json');
}

export function jpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('Visual evidence is not a JPEG image');
  }

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break;

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > buffer.length) {
      throw new Error('Visual evidence has an invalid JPEG segment');
    }
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }

  throw new Error('Visual evidence JPEG does not contain image dimensions');
}

export function inspectVisualEvidence(buffer: Buffer): VisualEvidenceCapture['automated'] {
  const { width, height } = jpegDimensions(buffer);
  if (buffer.length < 4096) {
    throw new Error(`Visual evidence is suspiciously small (${buffer.length} bytes)`);
  }
  if (width < 320 || height < 200) {
    throw new Error(`Visual evidence dimensions are too small (${width}x${height})`);
  }

  return {
    contentContractPassed: true,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    byteLength: buffer.length,
    width,
    height,
  };
}

export function readVisualEvidenceManifest(manifestPath: string): VisualEvidenceManifest {
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as VisualEvidenceManifest;
  if (parsed.schemaVersion !== 1 || typeof parsed.captures !== 'object' || parsed.captures === null) {
    throw new Error(`Invalid visual review manifest: ${manifestPath}`);
  }
  return parsed;
}

export function recordVisualEvidence(
  manifestPath: string,
  routeHost: string,
  label: string,
  screenshotPath: string,
  automated: VisualEvidenceCapture['automated'],
): VisualEvidenceManifest {
  const existing = fs.existsSync(manifestPath)
    ? readVisualEvidenceManifest(manifestPath)
    : { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), captures: {} };
  const previous = existing.captures[routeHost];
  const review = previous?.automated.sha256 === automated.sha256
    ? previous.review
    : { status: 'pending' as const };
  const generatedAt = new Date().toISOString();
  const manifest: VisualEvidenceManifest = {
    schemaVersion: 1,
    generatedAt,
    captures: {
      ...existing.captures,
      [routeHost]: {
        routeHost,
        label,
        file: path.relative(path.dirname(manifestPath), screenshotPath),
        capturedAt: generatedAt,
        automated,
        review,
      },
    },
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(temporaryPath, manifestPath);
  return manifest;
}

export function validateVisualEvidenceManifest(
  manifestPath: string,
  expectedHosts: string[],
  requireApproved = false,
): VisualEvidenceManifest {
  const manifest = readVisualEvidenceManifest(manifestPath);
  const missing = expectedHosts.filter((host) => !manifest.captures[host]);
  if (missing.length > 0) {
    throw new Error(`Visual review manifest is missing captures for: ${missing.join(', ')}`);
  }

  for (const host of expectedHosts) {
    const capture = manifest.captures[host];
    const imagePath = path.resolve(path.dirname(manifestPath), capture.file);
    const buffer = fs.readFileSync(imagePath);
    const actual = inspectVisualEvidence(buffer);
    if (actual.sha256 !== capture.automated.sha256) {
      throw new Error(`Visual evidence hash changed after capture for ${host}`);
    }
    if (requireApproved && capture.review.status !== 'approved') {
      throw new Error(`Visual evidence for ${host} requires human approval (status: ${capture.review.status})`);
    }
  }
  return manifest;
}
