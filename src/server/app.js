const express = require('express');
const app = express();
const cors = require('cors');

app.use(cors());
app.use(express.json());

const { transactions } = require('./routes/transactions');
const exchange = require('./routes/exchange');
const dashboard = require('./routes/dashboard');
const settings = require('./routes/settings');
const assets = require('./routes/assets');
const transfers = require('./routes/transfers');
const fileExport = require('./routes/exports');
const fileImport = require('./routes/imports');
const accounts = require('./routes/accounts');
const tax = require('./routes/tax');

app.use((req, _res, next) => {
  req.coineda_version = '0.1.6';
  next();
});

app.get('/alive', (_req, res) => {
  return res.status(200).end();
});

app.use('/transactions', transactions);
app.use('/exchange', exchange);
app.use('/dashboard', dashboard);
app.use('/settings', settings);
app.use('/assets', assets);
app.use('/transfers', transfers);
app.use('/accounts', accounts);
app.use('/import', fileImport);
app.use('/export', fileExport);
app.use('/tax', tax);

module.exports = app;
