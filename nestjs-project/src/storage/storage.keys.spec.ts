import { sourceExtension, sourceKey, thumbnailKey } from './storage.keys';

describe('storage.keys', () => {
  const videoId = '11111111-2222-3333-4444-555555555555';

  describe('sourceExtension', () => {
    it('should extract and lowercase the extension', () => {
      expect(sourceExtension('My Holiday.MP4')).toBe('.mp4');
    });

    it('should return an empty string when there is no extension', () => {
      expect(sourceExtension('video-without-extension')).toBe('');
    });

    it('should ignore an implausibly long extension', () => {
      expect(sourceExtension('file.thisisnotanextension')).toBe('');
    });

    it('should ignore an extension with unexpected characters', () => {
      expect(sourceExtension('file.mp4?x=1')).toBe('');
    });
  });

  describe('sourceKey', () => {
    it('should place the source under the video prefix keeping the extension', () => {
      expect(sourceKey(videoId, 'clip.webm')).toBe(
        `videos/${videoId}/source.webm`,
      );
    });

    it('should omit the suffix when the filename has no extension', () => {
      expect(sourceKey(videoId, 'clip')).toBe(`videos/${videoId}/source`);
    });
  });

  describe('thumbnailKey', () => {
    it('should place the thumbnail under the thumbnail prefix', () => {
      expect(thumbnailKey(videoId)).toBe(
        `thumbnails/${videoId}/thumbnail.jpg`,
      );
    });
  });
});
