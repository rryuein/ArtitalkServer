const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSdk(fetchImpl) {
  const source = fs.readFileSync(path.join(__dirname, '../../src/plugins', 'artitalk-av.js'), 'utf8');
  const storage = {};
  const context = {
    fetch: fetchImpl,
    URLSearchParams,
    localStorage: {
      getItem: (key) => storage[key] || null,
      setItem: (key, value) => { storage[key] = value; },
      removeItem: (key) => { delete storage[key]; }
    },
    window: {}
  };
  context.window = context;
  vm.runInNewContext(source, context);
  return context.AV;
}

test('Query.find sends LeanCloud-style query parameters to the API', async () => {
  const calls = [];
  const AV = loadSdk(async (url) => {
    calls.push(url);
    return {
      ok: true,
      json: async () => ({
        results: [{ objectId: 'talk1', attributes: { atContentMd: 'hello' } }]
      })
    };
  });

  AV.init({ serverURL: 'https://example.com' });
  const query = new AV.Query('shuoshuo');
  query.equalTo('objectId', 'talk1');
  query.descending('isPinned');
  query.addDescending('createdAt');
  query.limit(5);
  query.skip(10);
  const results = await query.find();

  assert.equal(results[0].id, 'talk1');
  assert.equal(calls[0], 'https://example.com/api/classes/shuoshuo?where=%7B%22objectId%22%3A%22talk1%22%7D&order=-isPinned%2C-createdAt&limit=5&skip=10');
});

test('Object.save creates and updates records through the API', async () => {
  const calls = [];
  const AV = loadSdk(async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({ objectId: 'new1', attributes: { atContentMd: 'hello' } })
    };
  });

  AV.init({ serverURL: 'https://example.com' });
  const Talk = AV.Object.extend('shuoshuo');
  const talk = new Talk();
  talk.set('atContentMd', 'hello');
  await talk.save();

  assert.equal(calls[0].url, 'https://example.com/api/classes/shuoshuo');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, '{"atContentMd":"hello"}');
});
