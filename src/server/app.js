const express = require('express');
const app = express();
const PORT = 5208;
const cors = require('cors');

app.use(cors());
app.use(express.json());

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend' });

const transactions = require('./routes/transactions.js');
const exchange = require('./routes/exchange.js');
const dashboard = require('./routes/dashboard');
const settings = require('./routes/settings');
const assets = require('./routes/assets');
const transfers = require('./routes/transfers');

const db = require('./database/helper.js');

app.get('/alive', (req, res) => {
  return res.status(200).end();
});

app.use('/transactions', transactions);
app.use('/exchange', exchange);
app.use('/dashboard', dashboard);
app.use('/settings', settings);
app.use('/assets', assets);
app.use('/transfers', transfers);

const server = app.listen(PORT, async () => {
  await db.init();
  logger.info('Coineda backend listening on localhost port ' + PORT);
});

module.exports = {
  server: server,
};
