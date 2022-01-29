const express = require('express');
const app = express();
const cors = require('cors');

app.use(cors());
app.use(express.json());

const { transactions } = require('./routes/transactions');
const exchange = require('./routes/exchange');
const dashboard = require('./routes/dashboard');
const transfers = require('./routes/transfers');
const fileExport = require('./routes/exports');
const fileImport = require('./routes/imports');
const tax = require('./routes/tax');

app.use((req, _res, next) => {
  req.coineda_version = '0.1.7';
  next();
});

app.get('/alive', (_req, res) => {
  return res.status(200).end();
});

app.use('/transactions', transactions);
app.use('/exchange', exchange);
app.use('/dashboard', dashboard);
app.use('/transfers', transfers);
app.use('/import', fileImport);
app.use('/export', fileExport);
app.use('/tax', tax);

module.exports = app;
