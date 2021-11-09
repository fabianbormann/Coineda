import { Table, Space, Tag, Button, message } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useEffect, useState, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import { AddTransactionDialog, AddTransferDialog } from '../dialogs';
import axios from 'axios';
import { ImportDialog } from '../dialogs';
import { SettingsContext } from '../SettingsContext';

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
    axios
      .get('http://localhost:5208/assets')
      .then((response) => {
        setAssets(response.data);
      })
      .catch((error) => {
        message.error('Failed to fetch assets');
        console.warn(error);
      });
  }, []);

  const fetchExchanges = useCallback(() => {
    if (assets.fiat.length === 0) {
      return;
    }

    const getAssetSymbol = (assetId) => {
      const { cryptocurrencies, fiat } = assets;
      return [...cryptocurrencies, ...fiat]
        .find((asset) => asset.id.toLowerCase() === assetId.toLowerCase())
        .symbol.toUpperCase();
    };

    axios
      .get('http://localhost:5208/transactions/' + account.id)
      .then((response) => {
        const formatDateTime = (timestamp) => {
          const date = new Date(timestamp);
          return `${
            date.toISOString().split('T')[0]
          } ${date.toLocaleTimeString()}`;
        };

        const data = response.data.map((transaction) => ({
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
          (transaction) => transaction.parent === null
        );

        for (const transaction of transactions) {
          const children = data.filter((row) => row.parent === transaction.id);
          if (children.length > 0) {
            transaction.children = children;
          }
        }

        axios
          .get('http://localhost:5208/transfers/' + account.id)
          .then((response) => {
            const transfers = response.data.map((transfer) => ({
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
  }, [assets, account]);

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
        children: `${roundCrypto(row.feeValue)} ${row.feeSymbol}`,
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
      await axios.delete('http://localhost:5208/transactions', {
        data: { transactions: [...selectedTransactions, ...children] },
      });

      await axios.delete('http://localhost:5208/transfers', {
        data: {
          transfers: selectedTransfers.map(
            (transferId) => transferId.split('-')[0]
          ),
        },
      });

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

    if (row.isComposed === 1) {
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
    const parentItems = selectedItems.filter((item) => item.isComposed === 0);
    if (parentItems.length < 2) {
      const childItems = selectedItems.filter((item) => item.isComposed === 1);

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
          href={`http://localhost:5208/export/${account.id}`}
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
