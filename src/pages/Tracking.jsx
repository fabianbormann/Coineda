import { Card, Space, Button, message, Tooltip } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SwapOutlined,
  ImportOutlined,
  ExportOutlined,
  DollarCircleOutlined,
  InteractionOutlined,
  ShoppingCartOutlined,
} from '@ant-design/icons';
import { useEffect, useState, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { createUseStyles } from 'react-jss';
import { AddTransactionDialog, AddTransferDialog } from '../dialogs';
import { exportData } from '../helper/export';
import { ImportDialog } from '../dialogs';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';
import moment from 'moment';

const { Meta } = Card;
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
  bucket: {
    '& > h2': {
      color: '#2f4858',
    },
  },
  operation: {
    fontSize: '1.6rem',
    borderRadius: '50%',
    color: 'white',
    padding: 8,
  },
  card: {
    width: 340,
    margin: 6,
    '@media screen and (max-width: 440px)': {
      width: 300,
    },
    '@media screen and (max-width: 400px)': {
      width: 260,
    },
    '@media screen and (max-width: 361px)': {
      width: 240,
    },
    '@media screen and (max-width: 321px)': {
      width: 200,
    },
  },
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    '& > div': {
      display: 'flex',
      alignItems: 'center',
      flexDirection: 'column',
      '& > div': {
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
      },
    },
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

  const closeAddTransactionDialog = () => {
    fetchExchanges();
    setAddTransactionDialogVisible(false);
    setTransactionOverrides(undefined);
  };

  const closeAddTransferDialog = () => {
    fetchExchanges();
    setAddTransferDialogVisible(false);
    setTransferOverrides(undefined);
  };

  const closeImportDialog = () => {
    setImportDialogVisible(false);
    fetchExchanges();
  };

  const openAddTransferDialog = () => setAddTransferDialogVisible(true);
  const openAddTransactionDialog = () => setAddTransactionDialogVisible(true);
  const openImportDialog = () => setImportDialogVisible(true);

  const deleteEntry = async (entry) => {
    if (entry.type === 'transfer') {
      await storage.transfers.delete(entry.id);
    } else {
      let entries = [entry];
      if (entry.hasOwnProperty('children')) {
        entries = [...entries, ...entry.children];
      }

      for (const action of entries) {
        await storage.transactions.delete(action.id);
      }
    }
    fetchExchanges();
  };

  const editEntry = (entry) => {
    if (entry.type === 'transfer') {
      setTransferOverrides(entry);
      setAddTransferDialogVisible(true);
    } else {
      setTransactionOverrides(entry);
      setAddTransactionDialogVisible(true);
    }
  };

  const buckets = [
    { label: 'Today', days: 0, operations: [] },
    { label: 'Yesterday', days: 1, operations: [] },
    { label: 'A few days ago', days: 6, operations: [] },
    { label: 'More than a week ago', days: 14, operations: [] },
    { label: 'Last Month', days: 30, operations: [] },
    { label: 'A few months ago', days: 182, operations: [] },
    { label: 'Over a half year ago', days: 365, operations: [] },
    { label: 'More than a year ago', days: 430, operations: [] },
    { label: 'Even longer ago', days: 730, operations: [] },
  ];

  const now = moment();
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|Opera Mini/i.test(
    navigator.userAgent
  );

  for (const operation of dataSource) {
    const daysSinceNow = now.diff(moment(operation.date), 'days');

    for (const bucket of buckets) {
      if (daysSinceNow <= bucket.days) {
        bucket.operations.push(operation);
        break;
      } else if (daysSinceNow > 729) {
        buckets[8].operations.push(operation);
        break;
      }
    }
  }

  return (
    <div className={classes.page}>
      <Space className={classes.actions}>
        <Tooltip title={t('Add Transaction')}>
          <Button
            size="large"
            type="primary"
            shape="circle"
            icon={<PlusOutlined />}
            onClick={openAddTransactionDialog}
          />
        </Tooltip>
        <Tooltip title={t('Add Transfer')}>
          <Button
            size="large"
            type="primary"
            shape="circle"
            icon={<SwapOutlined />}
            onClick={openAddTransferDialog}
          />
        </Tooltip>
        {!isMobileDevice && (
          <Tooltip title={t('Export')}>
            <Button
              size="large"
              type="primary"
              shape="circle"
              icon={<ExportOutlined />}
              onClick={() => exportData(account.id)}
            />
          </Tooltip>
        )}
        {!isMobileDevice && (
          <Tooltip title={t('Import')}>
            <Button
              size="large"
              type="primary"
              shape="circle"
              icon={<ImportOutlined />}
              onClick={openImportDialog}
            />
          </Tooltip>
        )}
      </Space>

      <div className={classes.container}>
        {buckets.map((bucket) => {
          if (bucket.operations.length === 0) {
            return null;
          } else {
            return (
              <div className={classes.bucket} key={bucket.label}>
                <h2>{bucket.label}</h2>
                <div>
                  {bucket.operations.map((operation) => {
                    const content = {};

                    if (operation.type === 'transfer') {
                      content.title = `Transfer`;
                      content.description = `${roundCrypto(operation.value)} ${
                        operation.symbol
                      } from ${operation.fromExchange} to ${
                        operation.toExchange
                      }`;
                      content.symbol = (
                        <SwapOutlined
                          className={classes.operation}
                          style={{ backgroundColor: '#2498E9' }}
                        />
                      );
                    } else if (operation.type === 'buy') {
                      content.title = `Buy`;
                      content.description = `${roundCrypto(
                        operation.toValue
                      )} ${operation.toSymbol} for ${operation.fromValue} ${
                        operation.fromSymbol
                      }`;
                      content.symbol = (
                        <ShoppingCartOutlined
                          className={classes.operation}
                          style={{ backgroundColor: '#03a678' }}
                        />
                      );
                    } else if (operation.type === 'sell') {
                      content.title = `Sell`;
                      content.description = `${roundCrypto(
                        operation.toValue
                      )} ${operation.toSymbol} for ${operation.fromValue} ${
                        operation.fromSymbol
                      }`;
                      content.symbol = (
                        <DollarCircleOutlined
                          className={classes.operation}
                          style={{ backgroundColor: '#E4E986' }}
                        />
                      );
                    } else if (operation.type === 'swap') {
                      content.title = `Swap`;
                      content.description = `${roundCrypto(
                        operation.fromValue
                      )} ${operation.fromSymbol} into ${roundCrypto(
                        operation.toValue
                      )} ${operation.toSymbol}`;
                      content.symbol = (
                        <InteractionOutlined
                          className={classes.operation}
                          style={{ backgroundColor: '#E66F4A' }}
                        />
                      );
                    }

                    return (
                      <Card
                        key={operation.id}
                        className={classes.card}
                        actions={[
                          <EditOutlined
                            onClick={() => editEntry(operation)}
                            key="edit"
                          />,
                          <DeleteOutlined
                            onClick={() => deleteEntry(operation)}
                            key="delete"
                          />,
                        ]}
                      >
                        <Meta
                          avatar={content.symbol}
                          description={content.description}
                          title={content.title}
                          extra={<span>{operation.date}</span>}
                        />
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          }
        })}
      </div>

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
