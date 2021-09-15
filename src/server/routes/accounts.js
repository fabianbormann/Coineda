const express = require('express');
const router = express.Router();
const db = require('../database/helper');

const bunyan = require('bunyan');
const { executeQuery } = require('../database/helper');
const logger = bunyan.createLogger({ name: 'coineda-backend-exchange' });

router.get('/', async (req, res) => {
  try {
    const sql = 'SELECT * FROM accounts';
    const accounts = await db.executeSelectQuery(sql);
    res.json(accounts);
  } catch (error) {
    logger.error(error);
    res.status(500).send('Failed to read accounts from database.');
  }
});

router.post('/', async (req, res) => {
  const { name, pattern } = req.body;

  try {
    await executeQuery('INSERT INTO accounts (name, pattern) VALUES (?, ?)', [
      name,
      pattern,
    ]);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).send('Failed to write account into database.');
  }
});

router.put('/', async (req, res) => {
  const { id, name, pattern } = req.body;

  try {
    await executeQuery('UPDATE accounts SET name=?, pattern=? WHERE id=?', [
      name,
      pattern,
      id,
    ]);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).send('Failed to update account.');
  }
});

router.delete('/', async (req, res) => {
  const { id } = req.body;

  try {
    await executeQuery('DELETE FROM accounts WHERE id=?', [id]);
    res.status(200).end();
  } catch (error) {
    logger.error(error);
    res.status(500).send('Failed to update account.');
  }
});

module.exports = router;
