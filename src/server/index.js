const app = require('./app.js');
const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend' });
const db = require('./database/helper');

const PORT = 5208;

const server = app.listen(PORT, async () => {
  await db.init();
  logger.info('Coineda backend listening on localhost port ' + PORT);
});

module.exports = {
  server: server,
};
