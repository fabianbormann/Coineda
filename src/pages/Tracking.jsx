import { Table, Divider, Typography, Space, Button, message } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import AddTransactionsDialog from '../dialogs/AddTransactionDialog';
import axios from 'axios';
import assets from '../settings/assets.json';

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
  const [addDialogVisible, setAddDialogVisible] = useState(false);
  const [dataSource, setDataSource] = useState([]);
  const [selectedRows, setSelectedRows] = useState([]);
  const [overrides, setOverrides] = useState();
  const classes = useStyles();

  const getAssetSymbol = (assetId) => {
    return [...assets.cryptocurrencies, ...assets.fiat]
      .find((asset) => asset.id.toLowerCase() === assetId.toLowerCase())
      .symbol.toUpperCase();
  };

  const fetchExchanges = useCallback(() => {
    axios
      .get('http://localhost:5208/transactions')
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

        setDataSource(transactions);
      })
      .catch((error) => {
        message.error(
          'Coineda backend is not available. Please restart the application.'
        );
        console.warn(error);
      });
  }, []);

  useEffect(() => {
    fetchExchanges();
  }, [fetchExchanges]);

  const rowSelection = {
    checkStrictly: false,
    onChange: (selectedRowKeys) => {
      setSelectedRows(selectedRowKeys);
    },
  };

  const columns = [
    {
      title: t('From'),
      dataIndex: 'from',
      key: 'from',
    },
    {
      title: t('To'),
      dataIndex: 'to',
      key: 'to',
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

  const closeAddDialog = () => {
    fetchExchanges();
    setAddDialogVisible(false);
    setOverrides(undefined);
  };

  const openAddDialog = () => setAddDialogVisible(true);

  const deleteRows = () => {
    axios
      .delete('http://localhost:5208/transactions', {
        data: { transactions: selectedRows },
      })
      .then(() => {
        fetchExchanges();
        setSelectedRows([]);
      })
      .catch((error) => {
        message.error(
          'Failed to remove the selected rows. Try to restart Coineda and try again. Contact support@coineda.io if the error persists.'
        );
        console.warn(error);
      });
  };

  const editRow = () => {
    if (selectedRows.length === 0) return;

    const row = dataSource.find((field) => field.key === selectedRows[0]);
    setOverrides(row);
    setAddDialogVisible(true);
  };

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Tracking')}</Title>
      <Divider className={classes.actions} />
      <Space className={classes.actions}>
        <Button type="primary" onClick={openAddDialog}>
          {t('Add Transaction')}
        </Button>
        <Button type="primary" onClick={openAddDialog}>
          {t('Add Transfer')}
        </Button>
        <Button type="primary">{t('Import')}</Button>
      </Space>
      <Space className={classes.actions}>
        <Button
          type="primary"
          icon={<DeleteOutlined />}
          disabled={selectedRows.length === 0}
          onClick={deleteRows}
        >
          Delete
        </Button>
        <Button
          type="primary"
          icon={<EditOutlined />}
          disabled={selectedRows.length !== 1}
          onClick={editRow}
        >
          Edit
        </Button>
      </Space>
      <Table
        rowSelection={{ ...rowSelection }}
        dataSource={dataSource}
        columns={columns}
      />
      <AddTransactionsDialog
        visible={addDialogVisible}
        onClose={closeAddDialog}
        overrides={overrides}
      />
    </div>
  );
};

export default Tracking;
