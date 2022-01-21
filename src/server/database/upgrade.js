let upgrades = ['1.7.0'];

const performUpgradeIfNeeded = async (executeSelectQuery, executeQuery) => {
  const rows = await executeSelectQuery('SELECT * FROM upgrades');

  if (rows.length === 0) {
    for (const version in upgrades) {
      await performUpgrade(version, executeQuery);
    }
  } else {
    let versions = rows.map((row) => row.version);
    upgrades = upgrades.filter((version) => !versions.includes(version));

    for (const version of upgrades) {
      await performUpgrade(version, executeQuery);
    }
  }
};

const performUpgrade = async (version, executeQuery) => {
  if (version === '1.7.0') {
    await executeQuery(
      'ALTER TABLE transactions ADD manuallyAdded INTEGER DEFAULT 1'
    );
    await executeQuery(
      'ALTER TABLE transfers ADD manuallyAdded INTEGER DEFAULT 1'
    );
    await executeQuery(
      "ALTER TABLE exchanges ADD walletType TEXT DEFAULT 'Other'"
    );
    await executeQuery("ALTER TABLE exchanges ADD apiKey TEXT DEFAULT ''");
    await executeQuery(
      "ALTER TABLE exchanges ADD publicAddress TEXT DEFAULT ''"
    );
    await executeQuery(
      'ALTER TABLE exchanges ADD automaticImport INTEGER DEFAULT 0'
    );
  }

  await executeQuery('INSERT INTO upgrades (version) VALUES (?)', [version]);
};

module.exports = performUpgradeIfNeeded;
