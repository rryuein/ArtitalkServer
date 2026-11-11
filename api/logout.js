const { createLogoutHandler } = require('../lib/api');
const { createStore } = require('../lib/store');

let handler;

module.exports = function logout(req, res) {
  if (!handler) handler = createLogoutHandler({ store: createStore() });
  return handler(req, res);
};
