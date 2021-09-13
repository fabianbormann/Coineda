import { Table, Divider, Typography, Space, Tag, Button, message } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useEffect, useState, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import { AddTransactionDialog, AddTransferDialog } from '../dialogs';
import axios from 'axios';
import { ImportDialog } from '../dialogs';
import { SettingsContext } from '../SettingsContext';

const { Title } = Typography;

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
          from: `${transaction.fromValue} ${getAssetSymbol(
            transaction.fromCurrency
          )}`,
          to: `${transaction.toValue} ${getAssetSymbol(
            transaction.toCurrency
          )}`,
          fee: `${transaction.feeValue} ${getAssetSymbol(
            transaction.feeCurrency
          )}`,
          feeCurrency: getAssetSymbol(transaction.feeCurrency),
          fromCurrency: getAssetSymbol(transaction.fromCurrency),
          toCurrency: getAssetSymbol(transaction.toCurrency),
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
          children: value,
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
          children: value,
          key: row.key,
        };
      },
    },
    {
      title: t('Fee'),
      dataIndex: 'fee',
      key: 'fee',
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

  const editRow = () => {
    if (selectedRows.length === 0) return;

    const row = dataSource.find((field) => field.key === selectedRows[0]);

    if (row.type === 'transfer') {
      setTransferOverrides(row);
      setAddTransferDialogVisible(true);
    } else {
      setTransactionOverrides(row);
      setAddTransactionDialogVisible(true);
    }
  };

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Tracking')}</Title>
      <Divider className={classes.actions} />
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
        <Button href="http://localhost:5208/export" type="primary">
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
          disabled={selectedRows.length !== 1}
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
