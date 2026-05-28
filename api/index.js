const { app, start } = require('../src/server');

let readyPromise = start();

module.exports = async (req, res) => {
  await readyPromise;
  return app(req, res);
};
