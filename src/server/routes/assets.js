const express = require('express');
const router = express.Router();
const common = require('../common.js');

router.get('/', async (req, res) => {
  const assets = await common.fetchAssets();
  return res.json(assets);
});

module.exports = router;
