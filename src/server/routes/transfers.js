const express = require('express');
const router = express.Router();

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-transfers' });

const db = require('../database/helper.js');

router.get('/', async (req, res) => {
  try {
    const transfers = await db.executeSelectQuery('SELECT * FROM transfers');
    res.json(transfers);
  } catch (error) {
    logger.error(error);
    res.status(500).send('Unable to read transfers from database');
  }
});

router.post('/', async (req, res) => {
  const {
    fromExchange,
    toExchange,
    value,
    currency,
    feeValue,
    feeCurrency,
    date,
  } = req.body;
  try {
    const sql =
      'INSERT INTO transfers (fromExchange, toExchange, value, currency, feeValue, feeCurrency, date) VALUES (?, ?, ?, ?, ?, ?, ?)';
    await db.executeQuery(sql, [
      fromExchange,
      toExchange,
      value,
      currency,
      feeValue,
      feeCurrency,
      date,
    ]);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).send('Failed to persist transfer');
  }
});

module.exports = router;
