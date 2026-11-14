import { describe, expect, it } from 'vitest';
import { pickRecording } from '../src/lib/zoom';

const f = (id: string, type: string, start: string, end: string) => ({ id, file_type: 'MP4', recording_type: type, status: 'completed', download_url: 'x', recording_start: start, recording_end: end });

describe('which Zoom file becomes the lecture', () => {
  it('the full class wins over a short screen-share file (12 Nov 2026)', () => {
    const p = pickRecording([
      f('short', 'shared_screen_with_speaker_view', '2026-11-12T13:27:00Z', '2026-11-12T13:39:00Z'),
      f('full', 'active_speaker', '2026-11-12T13:27:00Z', '2026-11-12T18:39:00Z'),
    ])!;
    expect(p.file.id).toBe('full');
  });
  it('among full-length files the preferred layout still wins', () => {
    const p = pickRecording([
      f('speaker', 'active_speaker', '2026-11-12T13:27:00Z', '2026-11-12T18:39:00Z'),
      f('share', 'shared_screen_with_speaker_view', '2026-11-12T13:27:00Z', '2026-11-12T18:38:00Z'),
    ])!;
    expect(p.file.id).toBe('share');
  });
  it('split parts of the same layout: the longest part', () => {
    const p = pickRecording([
      f('a', 'shared_screen_with_speaker_view', '2026-11-12T13:27:00Z', '2026-11-12T14:00:00Z'),
      f('b', 'shared_screen_with_speaker_view', '2026-11-12T14:05:00Z', '2026-11-12T18:00:00Z'),
    ])!;
    expect(p.file.id).toBe('b');
    expect(p.extraParts).toBe(1);
  });
});
