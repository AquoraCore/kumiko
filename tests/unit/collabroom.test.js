import { describe, it, expect } from 'vitest';
const { collabRoomName } = require('../../core/collabroom');
describe('collabRoomName — per-user room namespacing', () => {
  it('scopes by email when logged in', () => {
    expect(collabRoomName('a@x.com', 'A.md')).toBe('a@x.com::A.md');
  });
  it('two users with the same note name get DIFFERENT rooms', () => {
    expect(collabRoomName('a@x.com', 'A.md')).not.toBe(collabRoomName('b@x.com', 'A.md'));
  });
  it('same user + same note = SAME room (web<->desktop share)', () => {
    expect(collabRoomName('me@x.com', 'A.md')).toBe(collabRoomName('me@x.com', 'A.md'));
  });
  it('falls back to a bare room when no user (offline)', () => {
    expect(collabRoomName('', 'A.md')).toBe('A.md');
    expect(collabRoomName(null, 'A.md')).toBe('A.md');
  });
  it('defaults an empty note name to untitled', () => {
    expect(collabRoomName('a@x.com', '')).toBe('a@x.com::untitled');
    expect(collabRoomName('', null)).toBe('untitled');
  });
});
