const express = require('express');
const router = express.Router();
const db = require('../database/helper');

router.get('/:account', async (req, res) => {
  if (typeof req.params.account === 'undefined') {
    return res.status(400).send('Please provide an account id');
  }

  const sql = 'SELECT * FROM transactions WHERE account=?';
  const transactions = await db.executeSelectQuery(sql, [req.params.account]);

  const transfers = await db.executeSelectQuery(
    'SELECT * FROM transfers WHERE account=?',
    [req.params.account]
  );
  let data =
    '<header>\nformat:coineda\nversion:' +
    req.coineda_version +
    '\n</header>\n';
  data += '<transactions>';

  if (transactions.length > 0) {
    data += '\n';
    data += Object.keys(transactions[0]).join(';');

    for (const transaction of transactions) {
      data += '\n' + Object.values(transaction).join(';');
    }
  }

  data += '\n</transactions>\n<transfers>';

  if (transfers.length > 0) {
    data += '\n';
    data += Object.keys(transfers[0]).join(';');

    for (const transaction of transactions) {
      data += '\n' + Object.values(transaction).join(';');
    }
  }

  data += '\n</transfers>';

  const buffer = Buffer.from(data);
  const filename =
    'coineda-export-' + new Date().toISOString().split('T')[0] + '.cnd';
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-disposition': 'attachment; filename=' + filename,
  });
  res.write(buffer);
  res.end();
});

module.exports = router;
