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

const db = require('./database/helper.js');

app.get('/alive', (req, res) => {
  return res.status(200).end();
});

app.use('/transactions', transactions);
app.use('/exchange', exchange);
app.use('/dashboard', dashboard);

app.listen(PORT, async () => {
  await db.init();
  logger.info('Coineda backend listening on localhost port ' + PORT);
});
