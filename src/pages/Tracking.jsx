import { Table, Divider, Typography, Space, Button, message } from 'antd';
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
    marginBottom: 24,
  },
  page: {
    padding: 16,
  },
});

const Tracking = () => {
  const { t } = useTranslation();
  const [addDialogVisible, setAddDialogVisible] = useState(false);
  const [dataSource, setDataSource] = useState([]);
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
        setDataSource(
          response.data.map((transaction, key) => ({
            from: `${transaction.fromValue} ${getAssetSymbol(
              transaction.fromCurrency
            )}`,
            to: `${transaction.toValue} ${getAssetSymbol(
              transaction.toCurrency
            )}`,
            fee: `${transaction.feeValue} ${getAssetSymbol(
              transaction.feeCurrency
            )}`,
            date: formatDateTime(transaction.date),
            exchange: transaction.exchange,
            comment: transaction.comment,
            key: key,
          }))
        );
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
      sorter: (a, b) => new Date(a.date) - new Date(b.date),
      key: 'date',
    },
  ];

  const closeAddDialog = () => {
    fetchExchanges();
    setAddDialogVisible(false);
  };
  const openAddDialog = () => setAddDialogVisible(true);

  return (
    <div className={classes.page}>
      <Title level={2}>{t('Tracking')}</Title>
      <Divider />
      <Space className={classes.actions}>
        <Button type="primary" onClick={openAddDialog}>
          {t('Add Transaction')}
        </Button>
        <Button type="primary" onClick={openAddDialog}>
          {t('Add Transfer')}
        </Button>
        <Button type="primary">{t('Import')}</Button>
      </Space>
      <Table dataSource={dataSource} columns={columns} />
      <AddTransactionsDialog
        visible={addDialogVisible}
        onClose={closeAddDialog}
      />
    </div>
  );
};

export default Tracking;
