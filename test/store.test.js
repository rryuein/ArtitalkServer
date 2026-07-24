const assert = require('node:assert/strict');
const test = require('node:test');

const { mapOrder } = require('../lib/store');

test('mapOrder supports pinned talks followed by newest first', () => {
  assert.equal(mapOrder('-isPinned,-createdAt'), "(data->>'isPinned' = 'true') DESC, created_at DESC");
});

test('mapOrder rejects unsupported fields', () => {
  assert.throws(() => mapOrder('-unknown'), /Unsupported order field/);
});
