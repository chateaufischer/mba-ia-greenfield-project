import { PUBLIC_ID_LENGTH, generatePublicId } from './public-id.util';

describe('generatePublicId', () => {
  it('should produce an id of the declared length', () => {
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('should only use URL-safe base64url characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('should not collide across a large sample', () => {
    const sample = new Set<string>();
    const size = 20_000;

    for (let i = 0; i < size; i++) {
      sample.add(generatePublicId());
    }

    expect(sample.size).toBe(size);
  });
});
