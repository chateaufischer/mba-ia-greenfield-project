import { FfmpegService } from './ffmpeg.service';

describe('FfmpegService.thumbnailTimestamp', () => {
  const service = new FfmpegService();

  it('should take the frame at 10% of the duration', () => {
    expect(service.thumbnailTimestamp(60)).toBe(6);
    expect(service.thumbnailTimestamp(600)).toBe(60);
  });

  it('should never go below the one-second floor', () => {
    expect(service.thumbnailTimestamp(2)).toBe(1);
    expect(service.thumbnailTimestamp(0.5)).toBe(1);
  });

  it('should fall back to the floor when the duration is unknown', () => {
    expect(service.thumbnailTimestamp(null)).toBe(1);
  });

  it('should ignore a negative duration', () => {
    expect(service.thumbnailTimestamp(-10)).toBe(1);
  });
});
