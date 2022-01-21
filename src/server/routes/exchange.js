const express = require('express');
const router = express.Router();
const db = require('../database/helper');

const bunyan = require('bunyan');
const logger = bunyan.createLogger({ name: 'coineda-backend-exchange' });

router.get('/', async (req, res) => {
  const sql = 'SELECT * FROM exchanges';
  const exchanges = await db.executeSelectQuery(sql);
  return res.json(exchanges);
});

router.post('/', async (req, res) => {
  if (req.body.name === 'External Wallet') {
    return res.status(400).send('External Wallet is a reserved name');
  }

  try {
    await db.executeQuery(
      'INSERT INTO exchanges (name) VALUES (?)',
      req.body.name
    );
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).send('Error while trying to persist the new exchange');
  }
});

router.put('/', async (req, res) => {
  const { walletType, apiKey, publicAddress, automaticImport, name, id } =
    req.body;
  try {
    await db.executeQuery(
      'UPDATE exchanges SET walletType=?, apiKey=?, publicAddress=?, automaitcImport=? WHERE id=?',
      [walletType, apiKey, publicAddress, automaticImport, name, id]
    );
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).send('Failed to update exchange.');
  }
});

module.exports = router;
