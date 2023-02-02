import { useEffect, useState, useCallback, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { AddTransactionDialog, ImportDialog } from '../dialogs';
import { exportData } from '../helper/export';
import { SettingsContext } from '../SettingsContext';
import storage from '../persistence/storage';
import React from 'react';
import {
  CoinedaAsset,
  CoinedaAssets,
  MessageType,
  Transaction,
  TransactionBucket,
  TransactionCardContent,
  TransactionType,
} from '../global/types';
import {
  Alert,
  Box,
  Card,
  CardActions,
  CardContent,
  CardHeader,
  Grid,
  IconButton,
  Snackbar,
  styled,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import UploadIcon from '@mui/icons-material/Upload';
import SwapHorizontalCircleIcon from '@mui/icons-material/SwapHorizontalCircle';
import ShoppingCartIcon from '@mui/icons-material/ShoppingCart';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOn';
import SendIcon from '@mui/icons-material/Send';
import dayjs from 'dayjs';

const TransactionIcon = styled(Box, {
  shouldForwardProp: (prop) => prop !== 'color',
})(({ color }: { color: string }) => ({
  backgroundColor: color,
  color: 'white',
  borderRadius: '50%',
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'center',
}));

const Tracking = () => {
  const { t } = useTranslation();
  const { settings } = useContext(SettingsContext);
  const [addTransactionDialogVisible, setAddTransactionDialogVisible] =
    useState(false);
  const [importDialogVisible, setImportDialogVisible] = useState(false);
  const [dataSource, setDataSource] = useState<Array<Transaction>>([]);
  const [transactionOverrides, setTransactionOverrides] =
    useState<Transaction>();
  const [assets, setAssets] = useState<CoinedaAssets>({
    fiat: [],
    cryptocurrencies: [],
  });
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarType, setSnackbarType] = useState<MessageType>('success');
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const theme = useTheme();

  const { account } = settings;

  const roundCrypto = (value: number) => Math.round(value * 100000) / 100000;

  useEffect(() => {
    storage.assets.getAll().then((currencies) => {
      setAssets({
        fiat: currencies.filter((asset: CoinedaAsset) => asset.isFiat === 1),
        cryptocurrencies: currencies.filter(
          (asset: CoinedaAsset) => asset.isFiat === 2
        ),
      });
    });
  }, []);

  const getAssetSymbol = useCallback(
    (assetId: string) => {
      const { cryptocurrencies, fiat } = assets;
      const assetList = [...cryptocurrencies, ...fiat];
      const asset = assetList.find(
        (asset) => asset.id.toLowerCase() === assetId.toLowerCase()
      );

      if (asset) {
        return asset.symbol.toUpperCase();
      } else {
        return 'UNKNOWN';
      }
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
        const formatDateTime = (timestamp: number) => {
          const date = new Date(timestamp);
          return `${
            date.toISOString().split('T')[0]
          } ${date.toLocaleTimeString()}`;
        };

        const data = response.map((transaction: Transaction) => ({
          ...transaction,
          fromSymbol: getAssetSymbol(transaction.fromCurrency),
          toSymbol: getAssetSymbol(transaction.toCurrency),
          feeSymbol: getAssetSymbol(transaction.feeCurrency),
          feeCurrency: transaction.feeCurrency.toLowerCase(),
          fromCurrency: transaction.fromCurrency.toLowerCase(),
          toCurrency: transaction.toCurrency.toLowerCase(),
          formattedDate: formatDateTime(transaction.date),
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
            const transfers = response.map((transfer: Transaction) => ({
              ...transfer,
              type: 'transfer' as TransactionType,
              valueCurrency: transfer.currency,
              currency: getAssetSymbol(transfer.currency),
              fee: `${transfer.feeValue} ${getAssetSymbol(
                transfer.feeCurrency
              )}`,
              formattedDate: formatDateTime(transfer.date),
              exchange: `${transfer.fromExchange}, ${transfer.toExchange}`,
            }));

            setDataSource([...transactions, ...transfers]);
          })
          .catch((error) => {
            console.log(error);
            setSnackbarMessage(
              'Failed to fetch the transfers from the local storage. Please try it again. If the error persits consider to open an issue: https://github.com/fabianbormann/Coineda/issues'
            );
            setSnackbarOpen(true);
            setSnackbarType('warning');
          });
      })
      .catch((error) => {
        console.log(error);
        setSnackbarMessage(
          'Failed to fetch the transactions from the local storage. Please try it again. If the error persits consider to open an issue: https://github.com/fabianbormann/Coineda/issues'
        );
        setSnackbarOpen(true);
        setSnackbarType('warning');
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

  const closeImportDialog = () => {
    setImportDialogVisible(false);
    fetchExchanges();
  };

  const openAddTransactionDialog = () => setAddTransactionDialogVisible(true);
  const openImportDialog = () => setImportDialogVisible(true);

  const deleteEntry = async (entry: Transaction) => {
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

  const editEntry = (entry: Transaction) => {
    setTransactionOverrides(entry);
    setAddTransactionDialogVisible(true);
  };

  const buckets: Array<TransactionBucket> = [
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

  const now = dayjs();
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|Opera Mini/i.test(
    navigator.userAgent
  );

  for (const operation of dataSource) {
    const daysSinceNow = now.diff(dayjs(operation.formattedDate), 'days');

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

  const handleSnackbarClose = (
    event?: React.SyntheticEvent | Event,
    reason?: string
  ) => {
    if (reason === 'clickaway') {
      return;
    }

    setSnackbarOpen(false);
  };

  return (
    <Grid sx={{ p: 2 }}>
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={6000}
        onClose={handleSnackbarClose}
      >
        <Alert
          onClose={handleSnackbarClose}
          severity={snackbarType}
          sx={{ width: '100%' }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>

      <div>
        <Tooltip title={t('Add Transaction') as string}>
          <IconButton onClick={openAddTransactionDialog}>
            <AddCircleOutlineIcon />
          </IconButton>
        </Tooltip>
        {!isMobileDevice && (
          <Tooltip title={t('Export') as string}>
            <IconButton onClick={() => exportData(account.id)}>
              <FileDownloadIcon />
            </IconButton>
          </Tooltip>
        )}
        {!isMobileDevice && (
          <Tooltip title={t('Import') as string}>
            <IconButton onClick={openImportDialog}>
              <UploadIcon />
            </IconButton>
          </Tooltip>
        )}
      </div>

      <div>
        {buckets.map((bucket) => {
          if (bucket.operations.length === 0) {
            return null;
          } else {
            return (
              <Grid key={bucket.label}>
                <Typography sx={{ mb: 1, mt: 1 }} variant="h6">
                  {bucket.label}
                </Typography>
                <Grid container spacing={2}>
                  {bucket.operations.map((operation, OperationIndex) => {
                    const content: TransactionCardContent = {};

                    if (operation.type === 'transfer') {
                      content.title = `Transfer`;
                      content.description = `${roundCrypto(operation.value)} ${
                        operation.symbol
                      } from ${operation.fromExchange} to ${
                        operation.toExchange
                      }`;
                      content.symbol = (
                        <TransactionIcon
                          sx={{ p: 1 }}
                          color={theme.palette.info.light}
                        >
                          <SendIcon />
                        </TransactionIcon>
                      );
                    } else if (operation.type === 'buy') {
                      content.title = `Buy`;
                      content.description = `${roundCrypto(
                        operation.toValue
                      )} ${operation.toSymbol} for ${operation.fromValue} ${
                        operation.fromSymbol
                      }`;
                      content.symbol = (
                        <TransactionIcon
                          sx={{ p: 1 }}
                          color={theme.palette.success.light}
                        >
                          <ShoppingCartIcon />
                        </TransactionIcon>
                      );
                    } else if (operation.type === 'sell') {
                      content.title = `Sell`;
                      content.description = `${roundCrypto(
                        operation.toValue
                      )} ${operation.toSymbol} for ${operation.fromValue} ${
                        operation.fromSymbol
                      }`;
                      content.symbol = (
                        <TransactionIcon
                          sx={{ p: 1 }}
                          color={theme.palette.error.light}
                        >
                          <MonetizationOnIcon />
                        </TransactionIcon>
                      );
                    } else if (operation.type === 'swap') {
                      content.title = `Swap`;
                      content.description = `${roundCrypto(
                        operation.fromValue
                      )} ${operation.fromSymbol} into ${roundCrypto(
                        operation.toValue
                      )} ${operation.toSymbol}`;
                      content.symbol = (
                        <TransactionIcon
                          sx={{ p: 1 }}
                          color={theme.palette.warning.light}
                        >
                          <SwapHorizontalCircleIcon />
                        </TransactionIcon>
                      );
                    }

                    return (
                      <Grid item key={OperationIndex}>
                        <Card sx={{ maxWidth: 345 }} key={operation.id}>
                          <CardHeader
                            avatar={content.symbol}
                            title={content.title}
                            subheader={dayjs(operation.formattedDate).format(
                              'DD.MM.YYYY'
                            )}
                          />
                          <CardContent sx={{ p: 1, textAlign: 'center' }}>
                            <Typography variant="body2" color="text.secondary">
                              {content.description}
                            </Typography>
                          </CardContent>
                          <CardActions
                            sx={{ display: 'flex', justifyContent: 'center' }}
                          >
                            <Box
                              sx={{
                                display: 'flex',
                                flexGrow: 1,
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <IconButton
                                aria-label="edit transaction"
                                onClick={() => editEntry(operation)}
                              >
                                <EditIcon />
                              </IconButton>
                            </Box>
                            <Box
                              sx={{
                                display: 'flex',
                                flexGrow: 1,
                                alignItems: 'center',
                                justifyContent: 'center',
                              }}
                            >
                              <IconButton
                                aria-label="delete transaction"
                                onClick={() => deleteEntry(operation)}
                              >
                                <DeleteIcon />
                              </IconButton>
                            </Box>
                          </CardActions>
                        </Card>
                      </Grid>
                    );
                  })}
                </Grid>
              </Grid>
            );
          }
        })}
      </div>

      <AddTransactionDialog
        visible={addTransactionDialogVisible}
        onClose={closeAddTransactionDialog}
        overrides={transactionOverrides}
      />
      <ImportDialog visible={importDialogVisible} onClose={closeImportDialog} />
    </Grid>
  );
};

export default Tracking;
