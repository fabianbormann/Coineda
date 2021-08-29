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

router.delete('/', async (req, res) => {
  const sql = `DELETE FROM transfers WHERE id IN (
    ${req.body.transfers.join(', ')})`;

  try {
    await db.executeSelectQuery(sql);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).json(error);
  }
});

router.put('/', async (req, res) => {
  const {
    id,
    fromExchange,
    toExchange,
    value,
    currency,
    feeValue,
    feeCurrency,
    date,
  } = req.body;

  const sql =
    'UPDATE transfers SET fromExchange=?, toExchange=?, value=?, currency=?, feeValue=?, feeCurrency=?, date=? WHERE id=?';

  try {
    await db.executeQuery(sql, [
      fromExchange,
      toExchange,
      value,
      currency,
      feeValue,
      feeCurrency,
      date,
      id,
    ]);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).end();
  }
});

router.delete('/records', async (req, res) => {
  await db.executeSelectQuery('DELETE FROM transfers');
  res.status(200).end();
});

module.exports = router;
