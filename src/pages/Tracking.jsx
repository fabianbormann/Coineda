import { Table, Space, Tag, Button, message } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useEffect, useState, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import { AddTransactionDialog, AddTransferDialog } from '../dialogs';
import packageJSON from '../../package.json';
import { ImportDialog } from '../dialogs';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';

const useStyles = createUseStyles({
  actions: {
    marginTop: 0,
    marginBottom: 12,
  },
  page: {
    padding: 16,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
  },
});

const Tracking = () => {
  const { t } = useTranslation();
  const [settings] = useContext(SettingsContext);
  const [addTransactionDialogVisible, setAddTransactionDialogVisible] =
    useState(false);
  const [addTransferDialogVisible, setAddTransferDialogVisible] =
    useState(false);
  const [importDialogVisible, setImportDialogVisible] = useState(false);
  const [dataSource, setDataSource] = useState([]);
  const [selectedRows, setSelectedRows] = useState([]);
  const [transactionOverrides, setTransactionOverrides] = useState();
  const [transferOverrides, setTransferOverrides] = useState();
  const [assets, setAssets] = useState({ fiat: [], cryptocurrencies: [] });
  const classes = useStyles();

  const { account } = settings;

  const roundCrypto = (value) => Math.round(value * 100000) / 100000;

  useEffect(() => {
    storage.assets.getAll().then((currencies) => {
      setAssets({
        fiat: currencies.filter((asset) => asset.isFiat === 1),
        cryptocurrencies: currencies.filter((asset) => asset.isFiat === 2),
      });
    });
  }, []);

  const getAssetSymbol = useCallback(
    (assetId) => {
      const { cryptocurrencies, fiat } = assets;
      return [...cryptocurrencies, ...fiat]
        .find((asset) => asset.id.toLowerCase() === assetId.toLowerCase())
        .symbol.toUpperCase();
    },
    [assets]
  );

  const fetchExchanges = useCallback(() => {
    if (assets.fiat.length === 0) {
      return;
    }
    storage.transactions
      .getAllFromAccount(account.id)
      .then((response) => {
        const formatDateTime = (timestamp) => {
          const date = new Date(timestamp);
          return `${
            date.toISOString().split('T')[0]
          } ${date.toLocaleTimeString()}`;
        };

        const data = response.map((transaction) => ({
          ...transaction,
          fromSymbol: getAssetSymbol(transaction.fromCurrency),
          toSymbol: getAssetSymbol(transaction.toCurrency),
          feeSymbol: getAssetSymbol(transaction.feeCurrency),
          feeCurrency: transaction.feeCurrency.toLowerCase(),
          fromCurrency: transaction.fromCurrency.toLowerCase(),
          toCurrency: transaction.toCurrency.toLowerCase(),
          date: formatDateTime(transaction.date),
          key: transaction.id,
        }));

        const transactions = data.filter(
          (transaction) => typeof transaction.parent === 'undefined'
        );

        for (const transaction of transactions) {
          const children = data.filter((row) => row.parent === transaction.id);
          if (children.length > 0) {
            transaction.children = children;
          }
        }

        storage.transfers
          .getAllFromAccount(account.id)
          .then((response) => {
            const transfers = response.map((transfer) => ({
              ...transfer,
              type: 'transfer',
              valueCurrency: transfer.currency,
              currency: getAssetSymbol(transfer.currency),
              key: transfer.id + '-transfer',
              fee: `${transfer.feeValue} ${getAssetSymbol(
                transfer.feeCurrency
              )}`,
              date: formatDateTime(transfer.date),
              exchange: `${transfer.fromExchange}, ${transfer.toExchange}`,
            }));

            setDataSource([...transactions, ...transfers]);
          })
          .catch((error) => {
            message.error(
              'Coineda backend is not available. Please restart the application.'
            );
            console.warn(error);
          });
      })
      .catch((error) => {
        message.error(
          'Coineda backend is not available. Please restart the application.'
        );
        console.warn(error);
      });
  }, [assets, account, getAssetSymbol]);

  useEffect(() => {
    fetchExchanges();
  }, [fetchExchanges]);

  const rowSelection = {
    checkStrictly: false,
    onChange: (selectedRowKeys) => {
      setSelectedRows(selectedRowKeys);
    },
    selectedRowKeys: selectedRows,
  };

  const columns = [
    {
      title: t('From'),
      dataIndex: 'from',
      key: 'from',
      render: (value, row, index) => {
        if (row.type === 'transfer') {
          return {
            children: (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <div>{`${row.value} ${row.currency}`}</div>
                <Tag color="red">{row.fromExchange}</Tag>
              </div>
            ),
            key: row.key,
          };
        }

        return {
          children: `${roundCrypto(row.fromValue)} ${row.fromSymbol}`,
          key: row.key,
        };
      },
    },
    {
      title: t('To'),
      dataIndex: 'to',
      key: 'to',
      render: (value, row, index) => {
        if (row.type === 'transfer') {
          return {
            children: (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                }}
              >
                <div>{`${row.value} ${row.currency}`}</div>
                <Tag color="green">{row.toExchange}</Tag>
              </div>
            ),
            key: row.key,
          };
        }

        return {
          children: `${roundCrypto(row.toValue)} ${row.toSymbol}`,
          key: row.key,
        };
      },
    },
    {
      title: t('Fee'),
      dataIndex: 'fee',
      key: 'fee',
      render: (value, row, index) => ({
        children: `${roundCrypto(row.feeValue)} ${getAssetSymbol(
          row.feeCurrency
        )}`,
        key: row.key,
      }),
    },
    {
      title: t('Exchange'),
      dataIndex: 'exchange',
      sorter: (a, b) => a.exchange.localeCompare(b.exchange),
      key: 'exchange',
    },
    {
      title: t('Date'),
      dataIndex: 'date',
      defaultSortOrder: 'descend',
      sorter: (a, b) => new Date(a.date) - new Date(b.date),
      key: 'date',
    },
  ];

  const closeAddTransactionDialog = () => {
    setSelectedRows([]);
    fetchExchanges();
    setAddTransactionDialogVisible(false);
    setTransactionOverrides(undefined);
  };

  const closeAddTransferDialog = () => {
    setSelectedRows([]);
    fetchExchanges();
    setAddTransferDialogVisible(false);
    setTransferOverrides(undefined);
  };

  const closeImportDialog = () => {
    setSelectedRows([]);
    setImportDialogVisible(false);
    fetchExchanges();
  };

  const openAddTransferDialog = () => setAddTransferDialogVisible(true);
  const openAddTransactionDialog = () => setAddTransactionDialogVisible(true);
  const openImportDialog = () => setImportDialogVisible(true);

  const deleteRows = async () => {
    const selectedTransactions = selectedRows.filter((row) => {
      const selectedRow = dataSource.find((item) => item.key === row);
      if (selectedRow) {
        return selectedRow.type !== 'transfer';
      } else {
        return false;
      }
    });

    const selectedTransfers = selectedRows.filter((row) => {
      const selectedRow = dataSource.find((item) => item.key === row);
      if (selectedRow) {
        return selectedRow.type === 'transfer';
      } else {
        return false;
      }
    });

    let children = [];
    for (const selectedTransaction of selectedTransactions) {
      const selectedRow = dataSource.find(
        (item) => item.key === selectedTransaction
      );
      if (typeof selectedRow.children !== 'undefined') {
        children = [
          ...children,
          ...selectedRow.children.map((child) => child.key),
        ];
      }
    }

    try {
      for (const key of [...selectedTransactions, ...children]) {
        await storage.transactions.delete(key);
      }

      const transferIds = selectedTransfers.map(
        (transferId) => transferId.split('-')[0]
      );

      for (const key of transferIds) {
        await storage.transfers.delete(Number(key));
      }

      setSelectedRows([]);
      fetchExchanges();
    } catch (error) {
      message.error(
        'Failed to remove the selected rows. Try to restart Coineda and try again. Contact support@coineda.io if the error persists.'
      );
      console.warn(error);
    }
  };

  let editable = false;
  let rows = [];

  for (const row of dataSource) {
    rows.push(row);
    if (typeof row.children !== 'undefined') {
      rows = [...rows, ...row.children];
    }
  }

  const editRow = () => {
    if (selectedRows.length === 0) return;

    let row = rows.find((field) => field.key === selectedRows[0]);

    if (row.isComposed) {
      row = rows.find((field) => field.key === row.parent);
    }

    if (row.type === 'transfer') {
      setTransferOverrides(row);
      setAddTransferDialogVisible(true);
    } else {
      setTransactionOverrides(row);
      setAddTransactionDialogVisible(true);
    }
  };

  const selectedItems = selectedRows
    .map((selection) => rows.find((item) => item.key === selection))
    .filter((selection) => typeof selection !== 'undefined');

  if (selectedItems) {
    const parentItems = selectedItems.filter((item) => !item.isComposed);
    if (parentItems.length < 2) {
      const childItems = selectedItems.filter((item) => item.isComposed);

      if (parentItems.length === 0 && childItems.length > 0) {
        editable = childItems.every(
          (item) => item.parent === childItems[0].parent
        );
      } else if (parentItems.length === 1 && childItems.length > 0) {
        editable = childItems.every(
          (item) => item.parent === parentItems[0].id
        );
      } else if (parentItems.length === 1) {
        editable = true;
      }
    }
  }

  return (
    <div className={classes.page}>
      <Space className={classes.actions}>
        <Button type="primary" onClick={openAddTransactionDialog}>
          {t('Add Transaction')}
        </Button>
        <Button type="primary" onClick={openAddTransferDialog}>
          {t('Add Transfer')}
        </Button>
        <Button type="primary" onClick={openImportDialog}>
          {t('Import')}
        </Button>
        <Button
          onClick={async () => {
            const transactions = await storage.transactions.getAllFromAccount(
              account.id
            );
            const transfers = await storage.transfers.getAllFromAccount(
              account.id
            );

            let data =
              '<header>\nformat:coineda\nversion:' +
              packageJSON.version +
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

              for (const transfer of transfers) {
                data += '\n' + Object.values(transfer).join(';');
              }
            }

            data += '\n</transfers>';

            const filename =
              'coineda-export-' +
              new Date().toISOString().split('T')[0] +
              '.cnd';

            const element = document.createElement('a');
            element.setAttribute(
              'href',
              'data:text/plain;charset=utf-8,' + encodeURIComponent(data)
            );
            element.setAttribute('download', filename);
            element.style.display = 'none';
            document.body.appendChild(element);
            element.click();
            document.body.removeChild(element);
          }}
          type="primary"
        >
          {t('Export')}
        </Button>
      </Space>
      <Space className={classes.actions}>
        <Button
          type="primary"
          icon={<DeleteOutlined />}
          disabled={selectedRows.length === 0}
          onClick={deleteRows}
        >
          {t('Delete')}
        </Button>
        <Button
          type="primary"
          icon={<EditOutlined />}
          disabled={!editable}
          onClick={editRow}
        >
          {t('Edit')}
        </Button>
      </Space>
      <Table
        rowSelection={{ ...rowSelection }}
        dataSource={dataSource}
        columns={columns}
      />
      <AddTransactionDialog
        visible={addTransactionDialogVisible}
        onClose={closeAddTransactionDialog}
        overrides={transactionOverrides}
      />
      <AddTransferDialog
        visible={addTransferDialogVisible}
        onClose={closeAddTransferDialog}
        overrides={transferOverrides}
      />
      <ImportDialog visible={importDialogVisible} onClose={closeImportDialog} />
    </div>
  );
};

export default Tracking;
