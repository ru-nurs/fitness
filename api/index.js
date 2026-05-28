const server = require('../src/server');

const app = server.app || server;
let readyPromise = server.start ? server.start() : Promise.resolve(app);

module.exports = async (req, res) => {
  await readyPromise;
  return app(req, res);
};
